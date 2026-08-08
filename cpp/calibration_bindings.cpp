#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/objdetect/aruco_board.hpp>
#include <opencv2/objdetect/aruco_detector.hpp>
#include <opencv2/objdetect/charuco_detector.hpp>

namespace {

using emscripten::val;

constexpr double kPi = 3.14159265358979323846;
constexpr std::uint64_t kMaxSourcePixels = 40'000'000;
constexpr std::uint64_t kMaxProcessingPixels = 20'000'000;
constexpr int kMaxPatternGridSize = 30;
constexpr int kMaxObservations = 100;
constexpr int kMaxPointsPerObservation = 1'000;
constexpr float kCharucoSquareLength = 1.0F;
constexpr float kCharucoMarkerLength = 0.7F;

struct Observation {
  std::string id;
  std::vector<cv::Point2f> image_points;
  std::vector<cv::Point3f> object_points;
  std::vector<int> point_ids;
};

struct SolveState {
  cv::Mat camera_matrix;
  cv::Mat distortion;
  std::vector<cv::Mat> rotation_vectors;
  std::vector<cv::Mat> translation_vectors;
  std::vector<double> errors;
  std::vector<std::vector<cv::Point2f>> projected_points;
  double rms = std::numeric_limits<double>::quiet_NaN();
};

struct StabilityState {
  int attempted_samples = 0;
  int successful_samples = 0;
  std::vector<double> standard_deviations;
  std::vector<double> max_absolute_deltas;
};

cv::aruco::PredefinedDictionaryType dictionary_type(const std::string& name) {
  if (name.size() > 64) throw std::runtime_error("Invalid ArUco dictionary name.");
  static const std::map<std::string, cv::aruco::PredefinedDictionaryType> dictionaries = {
      {"DICT_4X4_50", cv::aruco::DICT_4X4_50},
      {"DICT_4X4_100", cv::aruco::DICT_4X4_100},
      {"DICT_4X4_250", cv::aruco::DICT_4X4_250},
      {"DICT_4X4_1000", cv::aruco::DICT_4X4_1000},
      {"DICT_5X5_50", cv::aruco::DICT_5X5_50},
      {"DICT_5X5_100", cv::aruco::DICT_5X5_100},
      {"DICT_5X5_250", cv::aruco::DICT_5X5_250},
      {"DICT_5X5_1000", cv::aruco::DICT_5X5_1000},
      {"DICT_6X6_50", cv::aruco::DICT_6X6_50},
      {"DICT_6X6_100", cv::aruco::DICT_6X6_100},
      {"DICT_6X6_250", cv::aruco::DICT_6X6_250},
      {"DICT_6X6_1000", cv::aruco::DICT_6X6_1000},
      {"DICT_7X7_50", cv::aruco::DICT_7X7_50},
      {"DICT_7X7_100", cv::aruco::DICT_7X7_100},
      {"DICT_7X7_250", cv::aruco::DICT_7X7_250},
      {"DICT_7X7_1000", cv::aruco::DICT_7X7_1000},
      {"DICT_ARUCO_ORIGINAL", cv::aruco::DICT_ARUCO_ORIGINAL},
  };
  const auto entry = dictionaries.find(name);
  if (entry == dictionaries.end()) throw std::runtime_error("Unsupported ArUco dictionary: " + name);
  return entry->second;
}

template <typename T>
val number_array(const std::vector<T>& values) {
  val result = val::array();
  for (const T& value : values) result.call<void>("push", value);
  return result;
}

val point2_array(const std::vector<cv::Point2f>& points) {
  val result = val::array();
  for (const auto& point : points) {
    val item = val::object();
    item.set("x", point.x);
    item.set("y", point.y);
    result.call<void>("push", item);
  }
  return result;
}

val point3_array(const std::vector<cv::Point3f>& points) {
  val result = val::array();
  for (const auto& point : points) {
    val item = val::object();
    item.set("x", point.x);
    item.set("y", point.y);
    item.set("z", point.z);
    result.call<void>("push", item);
  }
  return result;
}

std::uint64_t checked_pixel_count(int width,
                                  int height,
                                  std::uint64_t maximum,
                                  const char* limit_message) {
  if (width <= 0 || height <= 0) throw std::runtime_error("Invalid image dimensions.");
  const std::uint64_t pixels = static_cast<std::uint64_t>(width) *
                               static_cast<std::uint64_t>(height);
  if (pixels > maximum) throw std::runtime_error(limit_message);
  return pixels;
}

std::size_t checked_image_byte_count(int width, int height) {
  const std::uint64_t pixels = checked_pixel_count(
      width, height, kMaxProcessingPixels,
      "The image exceeds the 20-megapixel native processing limit.");
  return static_cast<std::size_t>(pixels * 4U);
}

int bounded_array_length(const val& array, int maximum, const std::string& label) {
  const double length = array["length"].as<double>();
  if (!std::isfinite(length) || length < 0.0 || length > maximum ||
      std::floor(length) != length) {
    throw std::runtime_error(label + " has an invalid length.");
  }
  return static_cast<int>(length);
}

int pattern_dimension(const val& pattern, const char* key) {
  const double value = pattern[key].as<double>();
  if (!std::isfinite(value) || std::floor(value) != value || value < 3.0 ||
      value > kMaxPatternGridSize) {
    throw std::runtime_error(std::string(key) +
                             " must be a whole number between 3 and 30.");
  }
  return static_cast<int>(value);
}

void validate_charuco_dictionary(int squares_x,
                                 int squares_y,
                                 const cv::aruco::Dictionary& dictionary) {
  const int marker_count = squares_x * squares_y / 2;
  if (marker_count > dictionary.bytesList.rows) {
    throw std::runtime_error("The selected ArUco dictionary has too few markers for this board.");
  }
}

std::vector<unsigned char> copy_bytes(const val& typed_array, std::size_t expected_length) {
  const double supplied_length = typed_array["byteLength"].as<double>();
  if (!std::isfinite(supplied_length) || supplied_length != expected_length) {
    throw std::runtime_error("The RGBA buffer size does not match the image dimensions.");
  }
  std::vector<unsigned char> bytes(expected_length);
  val destination = val(emscripten::typed_memory_view(bytes.size(), bytes.data()));
  destination.call<void>("set", typed_array);
  return bytes;
}

val copied_uint8_array(const unsigned char* data, std::size_t length) {
  val output = val::global("Uint8Array").new_(length);
  val source = val(emscripten::typed_memory_view(length, data));
  output.call<void>("set", source);
  return output;
}

double laplacian_variance(const cv::Mat& gray) {
  cv::Mat laplacian;
  cv::Laplacian(gray, laplacian, CV_64F);
  cv::Scalar mean;
  cv::Scalar standard_deviation;
  cv::meanStdDev(laplacian, mean, standard_deviation);
  return standard_deviation[0] * standard_deviation[0];
}

double convex_hull_area(const std::vector<cv::Point2f>& points) {
  if (points.size() < 3) return 0.0;
  std::vector<cv::Point2f> hull;
  cv::convexHull(points, hull);
  return std::abs(cv::contourArea(hull));
}

using GridKey = std::pair<std::int64_t, std::int64_t>;

GridKey object_grid_key(const cv::Point3f& point) {
  constexpr double kCoordinateScale = 10'000.0;
  return {static_cast<std::int64_t>(std::llround(point.x * kCoordinateScale)),
          static_cast<std::int64_t>(std::llround(point.y * kCoordinateScale))};
}

double perspective_skew(const std::vector<cv::Point3f>& object_points,
                        const std::vector<cv::Point2f>& image_points) {
  if (object_points.size() < 4 || image_points.size() != object_points.size()) return 0.0;
  std::map<GridKey, std::size_t> point_indices;
  for (std::size_t index = 0; index < object_points.size(); ++index) {
    point_indices.emplace(object_grid_key(object_points[index]), index);
  }

  double largest_object_area = 0.0;
  std::array<std::size_t, 3> best_indices{};
  bool found_rectangle = false;
  for (std::size_t first = 0; first < object_points.size(); ++first) {
    const GridKey first_key = object_grid_key(object_points[first]);
    for (std::size_t second = first + 1; second < object_points.size(); ++second) {
      const GridKey second_key = object_grid_key(object_points[second]);
      if (first_key.first == second_key.first || first_key.second == second_key.second) continue;
      const std::int64_t min_x = std::min(first_key.first, second_key.first);
      const std::int64_t max_x = std::max(first_key.first, second_key.first);
      const std::int64_t min_y = std::min(first_key.second, second_key.second);
      const std::int64_t max_y = std::max(first_key.second, second_key.second);
      const auto upper_left = point_indices.find({min_x, min_y});
      const auto upper_right = point_indices.find({max_x, min_y});
      const auto lower_right = point_indices.find({max_x, max_y});
      if (upper_left == point_indices.end() || upper_right == point_indices.end() ||
          lower_right == point_indices.end() ||
          point_indices.find({min_x, max_y}) == point_indices.end()) {
        continue;
      }
      const double object_area = static_cast<double>(max_x - min_x) *
                                 static_cast<double>(max_y - min_y);
      if (object_area <= largest_object_area) continue;
      largest_object_area = object_area;
      best_indices = {upper_left->second, upper_right->second, lower_right->second};
      found_rectangle = true;
    }
  }
  if (!found_rectangle) return 0.0;

  const cv::Point2f left = image_points[best_indices[0]] - image_points[best_indices[1]];
  const cv::Point2f down = image_points[best_indices[2]] - image_points[best_indices[1]];
  const double denominator = cv::norm(left) * cv::norm(down);
  if (!std::isfinite(denominator) || denominator <= std::numeric_limits<double>::epsilon()) {
    return 0.0;
  }
  const double cosine = std::clamp(static_cast<double>(left.dot(down)) / denominator, -1.0, 1.0);
  const double angle = std::acos(cosine);
  return std::clamp(2.0 * std::abs(kPi / 2.0 - angle), 0.0, 1.0);
}

double minimum_edge_distance(const std::vector<cv::Point2f>& points, int width, int height) {
  double minimum = std::numeric_limits<double>::infinity();
  for (const auto& point : points) {
    minimum = std::min(
        minimum,
        std::min({static_cast<double>(point.x), static_cast<double>(point.y),
                  static_cast<double>(width) - point.x,
                  static_cast<double>(height) - point.y}));
  }
  return std::isfinite(minimum) ? minimum : 0.0;
}

double provisional_plane_angle(const std::vector<cv::Point3f>& object_points,
                               const std::vector<cv::Point2f>& image_points,
                               int width,
                               int height) {
  if (object_points.size() < 4 || image_points.size() != object_points.size()) return 0.0;
  const double focal = static_cast<double>(std::max(width, height));
  cv::Mat camera_matrix = (cv::Mat_<double>(3, 3) << focal, 0.0, width / 2.0, 0.0, focal,
                           height / 2.0, 0.0, 0.0, 1.0);
  cv::Mat rotation_vector;
  cv::Mat translation_vector;
  try {
    if (!cv::solvePnP(object_points, image_points, camera_matrix, cv::noArray(), rotation_vector,
                      translation_vector, false, cv::SOLVEPNP_ITERATIVE)) {
      return 0.0;
    }
    cv::Mat rotation;
    cv::Rodrigues(rotation_vector, rotation);
    const double normal_z = std::clamp(std::abs(rotation.at<double>(2, 2)), 0.0, 1.0);
    return std::acos(normal_z) * 180.0 / kPi;
  } catch (const cv::Exception&) {
    return 0.0;
  }
}

val detection_result(const std::vector<cv::Point2f>& image_points,
                     const std::vector<cv::Point3f>& object_points,
                     const std::vector<int>& point_ids,
                     int width,
                     int height,
                     int available_corners,
                     bool require_all,
                     double sharpness) {
  const double board_area = convex_hull_area(image_points);
  const double area_ratio = board_area /
                            (static_cast<double>(width) * static_cast<double>(height));
  const double edge_distance = minimum_edge_distance(image_points, width, height);
  const int required = require_all
                           ? available_corners
                           : std::max(12, static_cast<int>(std::ceil(available_corners * 0.4)));
  const bool enough_corners = static_cast<int>(image_points.size()) >= required;
  const bool area_valid = area_ratio >= 0.05 && area_ratio <= 0.8;
  const bool edges_valid = edge_distance >= 12.0;
  const bool sharpness_valid = sharpness >= 80.0;
  const bool basic_valid = enough_corners && area_valid && edges_valid && sharpness_valid;

  double center_x = 0.5;
  double center_y = 0.5;
  if (!image_points.empty()) {
    double mean_x = 0.0;
    double mean_y = 0.0;
    for (const auto& point : image_points) {
      mean_x += point.x;
      mean_y += point.y;
    }
    mean_x /= image_points.size();
    mean_y /= image_points.size();
    const double board_extent = std::sqrt(std::max(0.0, board_area));
    const double horizontal_range = width - board_extent;
    const double vertical_range = height - board_extent;
    center_x = horizontal_range > 1.0
                   ? (mean_x - board_extent / 2.0) / horizontal_range
                   : mean_x / width;
    center_y = vertical_range > 1.0
                   ? (mean_y - board_extent / 2.0) / vertical_range
                   : mean_y / height;
    center_x = std::clamp(center_x, 0.0, 1.0);
    center_y = std::clamp(center_y, 0.0, 1.0);
  }
  const int column = std::clamp(static_cast<int>(center_x * 3.0), 0, 2);
  const int row = std::clamp(static_cast<int>(center_y * 3.0), 0, 2);

  val messages = val::array();
  if (!enough_corners) messages.call<void>("push", std::string("Show more of the board."));
  if (area_ratio < 0.05) messages.call<void>("push", std::string("Move the board closer."));
  if (area_ratio > 0.8) messages.call<void>("push", std::string("Move the board farther away."));
  if (!edges_valid) {
    messages.call<void>("push", std::string("Keep the entire board away from the image edge."));
  }
  if (!sharpness_valid) {
    messages.call<void>("push", std::string("Improve focus or hold the board still."));
  }
  if (basic_valid) messages.call<void>("push", std::string("Board detected. Hold steady."));

  val quality = val::object();
  quality.set("sharpness", sharpness);
  quality.set("boardAreaRatio", area_ratio);
  quality.set("minEdgeDistancePx", edge_distance);
  quality.set("detectedCorners", image_points.size());
  quality.set("availableCorners", available_corners);
  quality.set("basicValid", basic_valid);
  quality.set("messages", messages);

  val pose = val::object();
  pose.set("centerX", center_x);
  pose.set("centerY", center_y);
  pose.set("areaRatio", area_ratio);
  pose.set("planeAngleDegrees",
           provisional_plane_angle(object_points, image_points, width, height));
  pose.set("skew", perspective_skew(object_points, image_points));
  pose.set("coverageCell", row * 3 + column);

  val image_size = val::object();
  image_size.set("width", width);
  image_size.set("height", height);

  val result = val::object();
  result.set("ok", true);
  result.set("imageSize", image_size);
  result.set("imagePoints", point2_array(image_points));
  result.set("objectPoints", point3_array(object_points));
  result.set("pointIds", number_array(point_ids));
  result.set("quality", quality);
  result.set("pose", pose);
  return result;
}

val failed_detection(int width, int height, const std::string& message) {
  val image_size = val::object();
  image_size.set("width", width);
  image_size.set("height", height);
  val quality = val::object();
  quality.set("sharpness", 0.0);
  quality.set("boardAreaRatio", 0.0);
  quality.set("minEdgeDistancePx", 0.0);
  quality.set("detectedCorners", 0);
  quality.set("availableCorners", 0);
  quality.set("basicValid", false);
  val messages = val::array();
  messages.call<void>("push", message);
  quality.set("messages", messages);
  val pose = val::object();
  pose.set("centerX", 0.5);
  pose.set("centerY", 0.5);
  pose.set("areaRatio", 0.0);
  pose.set("planeAngleDegrees", 0.0);
  pose.set("skew", 0.0);
  pose.set("coverageCell", 4);
  val result = val::object();
  result.set("ok", true);
  result.set("imageSize", image_size);
  result.set("imagePoints", val::array());
  result.set("objectPoints", val::array());
  result.set("pointIds", val::array());
  result.set("quality", quality);
  result.set("pose", pose);
  return result;
}

val detect_frame(const val& rgba, int width, int height, const val& pattern) {
  std::vector<unsigned char> bytes = copy_bytes(rgba, checked_image_byte_count(width, height));
  cv::Mat source(height, width, CV_8UC4, bytes.data());
  cv::Mat gray;
  cv::cvtColor(source, gray, cv::COLOR_RGBA2GRAY);
  const double sharpness = laplacian_variance(gray);
  const std::string kind = pattern["kind"].as<std::string>();

  if (kind == "charuco") {
    const int squares_x = pattern_dimension(pattern, "squaresX");
    const int squares_y = pattern_dimension(pattern, "squaresY");
    const std::string dictionary_name = pattern["dictionary"].as<std::string>();
    const bool legacy_pattern = pattern["legacyPattern"].as<bool>();
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictionary_type(dictionary_name));
    validate_charuco_dictionary(squares_x, squares_y, dictionary);
    cv::aruco::CharucoBoard board(cv::Size(squares_x, squares_y),
                                  kCharucoSquareLength,
                                  kCharucoMarkerLength, dictionary);
    board.setLegacyPattern(legacy_pattern);
    cv::aruco::CharucoDetector detector(board);
    std::vector<cv::Point2f> corners;
    std::vector<int> ids;
    detector.detectBoard(gray, corners, ids);
    if (corners.empty()) return failed_detection(width, height, "Show the ChArUco board to the camera.");
    std::vector<cv::Point3f> object_points;
    const auto& board_corners = board.getChessboardCorners();
    object_points.reserve(ids.size());
    for (const int id : ids) {
      if (id < 0 || id >= static_cast<int>(board_corners.size())) {
        throw std::runtime_error("ChArUco returned an invalid corner identifier.");
      }
      object_points.push_back(board_corners[id]);
    }
    return detection_result(corners, object_points, ids, width, height,
                            (squares_x - 1) * (squares_y - 1), false, sharpness);
  }

  if (kind == "chessboard") {
    const int corners_x = pattern_dimension(pattern, "innerCornersX");
    const int corners_y = pattern_dimension(pattern, "innerCornersY");
    std::vector<cv::Point2f> corners;
    const bool found = cv::findChessboardCornersSB(
        gray, cv::Size(corners_x, corners_y), corners,
        cv::CALIB_CB_NORMALIZE_IMAGE | cv::CALIB_CB_EXHAUSTIVE | cv::CALIB_CB_ACCURACY);
    if (!found) return failed_detection(width, height, "Show the complete chessboard to the camera.");
    std::vector<cv::Point3f> object_points;
    std::vector<int> ids;
    object_points.reserve(corners_x * corners_y);
    ids.reserve(corners_x * corners_y);
    for (int row = 0; row < corners_y; ++row) {
      for (int column = 0; column < corners_x; ++column) {
        object_points.emplace_back(static_cast<float>(column), static_cast<float>(row), 0.0f);
        ids.push_back(row * corners_x + column);
      }
    }
    return detection_result(corners, object_points, ids, width, height,
                            corners_x * corners_y, true, sharpness);
  }

  throw std::runtime_error("Unsupported calibration pattern.");
}

float finite_coordinate(const val& value, const std::string& label) {
  const double coordinate = value.as<double>();
  if (!std::isfinite(coordinate) || std::abs(coordinate) > 10'000'000.0) {
    throw std::runtime_error(label + " contains an invalid coordinate.");
  }
  return static_cast<float>(coordinate);
}

std::vector<Observation> parse_observations(const val& input, int width, int height) {
  const int count = bounded_array_length(input, kMaxObservations, "Calibration observations");
  std::vector<Observation> observations;
  observations.reserve(count);
  std::set<std::string> observation_ids;
  for (int index = 0; index < count; ++index) {
    const val item = input[index];
    Observation observation;
    observation.id = item["id"].as<std::string>();
    if (observation.id.empty() || observation.id.size() > 1'024 ||
        !observation_ids.insert(observation.id).second) {
      throw std::runtime_error("Calibration view identifiers must be non-empty and unique.");
    }
    const val image_points = item["imagePoints"];
    const val object_points = item["objectPoints"];
    const val point_ids = item["pointIds"];
    const int point_count = bounded_array_length(
        image_points, kMaxPointsPerObservation, "Calibration image points");
    if (point_count != bounded_array_length(object_points, kMaxPointsPerObservation,
                                             "Calibration object points") ||
        point_count != bounded_array_length(point_ids, kMaxPointsPerObservation,
                                            "Calibration point identifiers") ||
        point_count < 4) {
      throw std::runtime_error("Each calibration view needs matching image and object points.");
    }
    observation.image_points.reserve(point_count);
    observation.object_points.reserve(point_count);
    observation.point_ids.reserve(point_count);
    std::set<int> unique_point_ids;
    for (int point_index = 0; point_index < point_count; ++point_index) {
      const val image_point = image_points[point_index];
      const val object_point = object_points[point_index];
      const float image_x = finite_coordinate(image_point["x"], "Image point");
      const float image_y = finite_coordinate(image_point["y"], "Image point");
      if (image_x < -width || image_x > width * 2.0F || image_y < -height ||
          image_y > height * 2.0F) {
        throw std::runtime_error("A calibration image point is outside the valid range.");
      }
      const double point_id_value = point_ids[point_index].as<double>();
      if (!std::isfinite(point_id_value) || std::floor(point_id_value) != point_id_value ||
          point_id_value < 0.0 || point_id_value > std::numeric_limits<int>::max()) {
        throw std::runtime_error("Calibration point identifiers must be non-negative integers.");
      }
      const int point_id = static_cast<int>(point_id_value);
      if (!unique_point_ids.insert(point_id).second) {
        throw std::runtime_error("Calibration point identifiers must be unique within each view.");
      }
      observation.image_points.emplace_back(image_x, image_y);
      observation.object_points.emplace_back(
          finite_coordinate(object_point["x"], "Object point"),
          finite_coordinate(object_point["y"], "Object point"),
          finite_coordinate(object_point["z"], "Object point"));
      observation.point_ids.push_back(point_id);
    }
    observations.push_back(std::move(observation));
  }
  return observations;
}

double view_error(const std::vector<cv::Point2f>& detected,
                  const std::vector<cv::Point2f>& projected) {
  if (detected.empty() || detected.size() != projected.size()) {
    throw std::runtime_error("OpenCV returned an invalid projected point set.");
  }
  double squared_error = 0.0;
  for (std::size_t index = 0; index < detected.size(); ++index) {
    const double dx = detected[index].x - projected[index].x;
    const double dy = detected[index].y - projected[index].y;
    squared_error += dx * dx + dy * dy;
  }
  const double error = std::sqrt(squared_error / detected.size());
  if (!std::isfinite(error)) throw std::runtime_error("OpenCV returned a non-finite view error.");
  return error;
}

SolveState solve_subset(const std::vector<Observation>& observations,
                        const std::vector<int>& active,
                        const std::string& model,
                        const cv::Size& image_size) {
  std::vector<std::vector<cv::Point3f>> object_points;
  std::vector<std::vector<cv::Point2f>> image_points;
  object_points.reserve(active.size());
  image_points.reserve(active.size());
  for (const int index : active) {
    object_points.push_back(observations[index].object_points);
    image_points.push_back(observations[index].image_points);
  }

  SolveState state;
  if (model == "pinhole-radtan5") {
    state.camera_matrix = cv::Mat::eye(3, 3, CV_64F);
    state.distortion = cv::Mat::zeros(5, 1, CV_64F);
    state.rms = cv::calibrateCamera(object_points, image_points, image_size,
                                    state.camera_matrix, state.distortion,
                                    state.rotation_vectors, state.translation_vectors, 0,
                                    cv::TermCriteria(cv::TermCriteria::COUNT |
                                                         cv::TermCriteria::EPS,
                                                     100, 1e-9));
  } else if (model == "fisheye-kb4") {
    state.camera_matrix = cv::Mat::eye(3, 3, CV_64F);
    state.distortion = cv::Mat::zeros(4, 1, CV_64F);
    state.rms = cv::fisheye::calibrate(
        object_points, image_points, image_size, state.camera_matrix, state.distortion,
        state.rotation_vectors, state.translation_vectors,
        cv::fisheye::CALIB_RECOMPUTE_EXTRINSIC | cv::fisheye::CALIB_CHECK_COND |
            cv::fisheye::CALIB_FIX_SKEW,
        cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 100, 1e-9));
  } else {
    throw std::runtime_error("Unsupported lens model.");
  }

  const int expected_distortion = model == "pinhole-radtan5" ? 5 : 4;
  if (state.camera_matrix.rows != 3 || state.camera_matrix.cols != 3 ||
      state.camera_matrix.type() != CV_64F ||
      static_cast<int>(state.distortion.total()) != expected_distortion ||
      !cv::checkRange(state.camera_matrix) || !cv::checkRange(state.distortion) ||
      state.camera_matrix.at<double>(0, 0) <= 0.0 ||
      state.camera_matrix.at<double>(1, 1) <= 0.0 || !std::isfinite(state.rms) ||
      state.rotation_vectors.size() != active.size() ||
      state.translation_vectors.size() != active.size()) {
    throw std::runtime_error("OpenCV returned an invalid calibration solution.");
  }
  for (std::size_t index = 0; index < active.size(); ++index) {
    if (state.rotation_vectors[index].total() != 3 ||
        state.translation_vectors[index].total() != 3 ||
        !cv::checkRange(state.rotation_vectors[index]) ||
        !cv::checkRange(state.translation_vectors[index])) {
      throw std::runtime_error("OpenCV returned invalid calibration poses.");
    }
  }

  state.errors.reserve(active.size());
  state.projected_points.reserve(active.size());
  double total_squared_error = 0.0;
  std::size_t total_points = 0;
  for (std::size_t local_index = 0; local_index < active.size(); ++local_index) {
    std::vector<cv::Point2f> projected;
    if (model == "pinhole-radtan5") {
      cv::projectPoints(object_points[local_index], state.rotation_vectors[local_index],
                        state.translation_vectors[local_index], state.camera_matrix,
                        state.distortion, projected);
    } else {
      cv::fisheye::projectPoints(object_points[local_index], projected,
                                 state.rotation_vectors[local_index],
                                 state.translation_vectors[local_index], state.camera_matrix,
                                 state.distortion);
    }
    const double error = view_error(image_points[local_index], projected);
    state.errors.push_back(error);
    state.projected_points.push_back(std::move(projected));
    total_squared_error += error * error * image_points[local_index].size();
    total_points += image_points[local_index].size();
  }
  if (total_points == 0) throw std::runtime_error("Calibration views contain no points.");
  state.rms = std::sqrt(total_squared_error / total_points);
  if (!std::isfinite(state.rms)) {
    throw std::runtime_error("OpenCV returned a non-finite reprojection error.");
  }
  return state;
}

double median(std::vector<double> values) {
  if (values.empty()) return 0.0;
  const std::size_t middle = values.size() / 2;
  std::nth_element(values.begin(), values.begin() + middle, values.end());
  const double upper = values[middle];
  if (values.size() % 2 == 1) return upper;
  std::nth_element(values.begin(), values.begin() + middle - 1, values.end());
  return (upper + values[middle - 1]) / 2.0;
}

std::vector<double> calibration_parameters(const SolveState& state) {
  std::vector<double> parameters = {
      state.camera_matrix.at<double>(0, 0), state.camera_matrix.at<double>(1, 1),
      state.camera_matrix.at<double>(0, 2), state.camera_matrix.at<double>(1, 2)};
  parameters.insert(parameters.end(), state.distortion.begin<double>(),
                    state.distortion.end<double>());
  return parameters;
}

StabilityState leave_one_view_out_stability(const std::vector<Observation>& observations,
                                            const std::vector<int>& active,
                                            const std::string& model,
                                            const cv::Size& image_size,
                                            const SolveState& final_state) {
  StabilityState stability;
  if (active.size() <= 12) return stability;

  constexpr int kMaximumSamples = 12;
  stability.attempted_samples =
      std::min(kMaximumSamples, static_cast<int>(active.size()));
  std::vector<std::vector<double>> samples;
  samples.reserve(stability.attempted_samples);
  for (int sample_index = 0; sample_index < stability.attempted_samples; ++sample_index) {
    const std::size_t position = stability.attempted_samples == 1
                                     ? 0
                                     : static_cast<std::size_t>(std::llround(
                                           sample_index * (active.size() - 1.0) /
                                           (stability.attempted_samples - 1.0)));
    std::vector<int> subset = active;
    subset.erase(subset.begin() + static_cast<std::ptrdiff_t>(position));
    try {
      samples.push_back(
          calibration_parameters(solve_subset(observations, subset, model, image_size)));
    } catch (const cv::Exception&) {
      // A failed subset is itself useful context; report it through the sample counts.
    } catch (const std::runtime_error&) {
      // A failed subset is itself useful context; report it through the sample counts.
    }
  }

  stability.successful_samples = static_cast<int>(samples.size());
  if (samples.size() < 3) return stability;
  const std::vector<double> final_parameters = calibration_parameters(final_state);
  stability.standard_deviations.resize(final_parameters.size(), 0.0);
  stability.max_absolute_deltas.resize(final_parameters.size(), 0.0);
  for (std::size_t parameter = 0; parameter < final_parameters.size(); ++parameter) {
    double mean = 0.0;
    for (const auto& sample : samples) mean += sample[parameter];
    mean /= samples.size();
    double squared_deviation = 0.0;
    double maximum_delta = 0.0;
    for (const auto& sample : samples) {
      const double centered = sample[parameter] - mean;
      squared_deviation += centered * centered;
      maximum_delta =
          std::max(maximum_delta, std::abs(sample[parameter] - final_parameters[parameter]));
    }
    stability.standard_deviations[parameter] =
        std::sqrt(squared_deviation / (samples.size() - 1));
    stability.max_absolute_deltas[parameter] = maximum_delta;
  }
  return stability;
}

int failed_fisheye_view(const cv::Exception& error) {
  static const std::array<std::string, 2> markers = {
      "CALIB_CHECK_COND - Ill-conditioned matrix for input array ",
      "FISHEYE_VIEW_INDEX ",
  };
  const std::string details = error.err.empty() ? error.what() : error.err;
  for (const std::string& marker : markers) {
    const std::size_t marker_position = details.find(marker);
    if (marker_position == std::string::npos) continue;
    std::istringstream index_stream(details.substr(marker_position + marker.size()));
    int index = -1;
    index_stream >> index;
    if (!index_stream.fail()) return index;
  }
  return -1;
}

cv::Mat centered_fisheye_preview_matrix(const cv::Mat& camera_matrix,
                                         const cv::Mat& distortion,
                                         const cv::Size& image_size,
                                         double balance) {
  cv::Mat preview_camera_matrix;
  cv::fisheye::estimateNewCameraMatrixForUndistortRectify(
      camera_matrix, distortion, image_size, cv::Matx33d::eye(),
      preview_camera_matrix, balance, image_size);
  if (preview_camera_matrix.rows != 3 || preview_camera_matrix.cols != 3 ||
      preview_camera_matrix.type() != CV_64F || !cv::checkRange(preview_camera_matrix) ||
      preview_camera_matrix.at<double>(0, 0) <= 0.0 ||
      preview_camera_matrix.at<double>(1, 1) <= 0.0) {
    throw std::runtime_error("OpenCV returned an invalid fisheye preview matrix.");
  }
  preview_camera_matrix.at<double>(0, 2) = image_size.width * 0.5;
  preview_camera_matrix.at<double>(1, 2) = image_size.height * 0.5;
  return preview_camera_matrix;
}

val solve_calibration(const val& input,
                      const std::string& model,
                      int width,
                      int height) {
  checked_pixel_count(width, height, kMaxSourcePixels,
                      "The calibration image exceeds the 40-megapixel limit.");
  if (model != "pinhole-radtan5" && model != "fisheye-kb4") {
    throw std::runtime_error("Unsupported lens model.");
  }
  std::vector<Observation> observations = parse_observations(input, width, height);
  if (observations.size() < 12) throw std::runtime_error("At least 12 valid views are required.");
  std::vector<int> active(observations.size());
  std::iota(active.begin(), active.end(), 0);
  std::map<std::string, double> all_errors;
  std::vector<int> excluded;
  SolveState state;
  const double absolute_threshold = model == "pinhole-radtan5" ? 1.5 : 2.0;
  int reprojection_exclusions = 0;

  while (true) {
    try {
      state = solve_subset(observations, active, model, cv::Size(width, height));
    } catch (const cv::Exception& error) {
      const int local_index = model == "fisheye-kb4" ? failed_fisheye_view(error) : -1;
      if (local_index < 0 || local_index >= static_cast<int>(active.size())) throw;
      const int observation_index = active[local_index];
      if (active.size() <= 12) {
        throw std::runtime_error(
            "Fisheye calibration cannot use view \"" +
            observations[observation_index].id +
            "\". Deselect that view or capture more tilted views around the image edges.");
      }
      excluded.push_back(observation_index);
      active.erase(active.begin() + local_index);
      continue;
    }

    for (std::size_t index = 0; index < active.size(); ++index) {
      all_errors[observations[active[index]].id] = state.errors[index];
    }
    if (reprojection_exclusions >= 3 || active.size() <= 12) break;
    const double center = median(state.errors);
    std::vector<double> deviations;
    deviations.reserve(state.errors.size());
    for (const double error : state.errors) deviations.push_back(std::abs(error - center));
    constexpr double kNormalConsistencyFactor = 1.4826;
    const double threshold = std::max(
        absolute_threshold, center + 3.0 * kNormalConsistencyFactor * median(deviations));
    const auto worst = std::max_element(state.errors.begin(), state.errors.end());
    if (worst == state.errors.end() || *worst <= threshold) break;
    const std::size_t local_index = std::distance(state.errors.begin(), worst);
    excluded.push_back(active[local_index]);
    active.erase(active.begin() + local_index);
    ++reprojection_exclusions;
  }

  val result = val::object();
  result.set("ok", true);
  result.set("opencvVersion", std::string(CV_VERSION));
  std::vector<double> camera_matrix(state.camera_matrix.begin<double>(),
                                    state.camera_matrix.end<double>());
  std::vector<double> distortion(state.distortion.begin<double>(), state.distortion.end<double>());
  result.set("cameraMatrix", number_array(camera_matrix));
  result.set("distortion", number_array(distortion));
  if (model == "fisheye-kb4") {
    const cv::Size image_size(width, height);
    cv::Mat preview_camera_matrix = centered_fisheye_preview_matrix(
        state.camera_matrix, state.distortion, image_size, 1.0);
    cv::Mat preview_fill_camera_matrix = centered_fisheye_preview_matrix(
        state.camera_matrix, state.distortion, image_size, 0.0);
    std::vector<double> preview_matrix(preview_camera_matrix.begin<double>(),
                                       preview_camera_matrix.end<double>());
    std::vector<double> preview_fill_matrix(preview_fill_camera_matrix.begin<double>(),
                                            preview_fill_camera_matrix.end<double>());
    result.set("previewCameraMatrix", number_array(preview_matrix));
    result.set("previewFillCameraMatrix", number_array(preview_fill_matrix));
  }
  result.set("rmsReprojectionError", state.rms);

  const StabilityState stability = leave_one_view_out_stability(
      observations, active, model, cv::Size(width, height), state);
  if (stability.attempted_samples > 0) {
    val stability_value = val::object();
    stability_value.set("method", std::string("leave-one-view-out"));
    stability_value.set("attemptedSamples", stability.attempted_samples);
    stability_value.set("successfulSamples", stability.successful_samples);
    stability_value.set("standardDeviations",
                        number_array(stability.standard_deviations));
    stability_value.set("maxAbsoluteDeltas",
                        number_array(stability.max_absolute_deltas));
    result.set("stability", stability_value);
  }

  val errors = val::object();
  for (const auto& [id, error] : all_errors) errors.set(id, error);
  result.set("perViewErrors", errors);

  val included_ids = val::array();
  val excluded_ids = val::array();
  val poses = val::array();
  val residuals = val::object();
  for (std::size_t local_index = 0; local_index < active.size(); ++local_index) {
    const Observation& observation = observations[active[local_index]];
    included_ids.call<void>("push", observation.id);
    val pose = val::object();
    pose.set("viewId", observation.id);
    std::vector<double> rotation(3);
    std::vector<double> translation(3);
    for (int axis = 0; axis < 3; ++axis) {
      rotation[axis] = state.rotation_vectors[local_index].at<double>(axis);
      translation[axis] = state.translation_vectors[local_index].at<double>(axis);
    }
    pose.set("rotationVector", number_array(rotation));
    pose.set("translationVector", number_array(translation));
    poses.call<void>("push", pose);

    val view_residuals = val::array();
    const auto& projected_points = state.projected_points[local_index];
    for (std::size_t point_index = 0; point_index < observation.image_points.size();
         ++point_index) {
      const cv::Point2f observed = observation.image_points[point_index];
      const cv::Point2f projected = projected_points[point_index];
      val residual = val::object();
      residual.set("pointId", observation.point_ids[point_index]);
      val observed_value = val::object();
      observed_value.set("x", observed.x);
      observed_value.set("y", observed.y);
      val projected_value = val::object();
      projected_value.set("x", projected.x);
      projected_value.set("y", projected.y);
      residual.set("observed", observed_value);
      residual.set("projected", projected_value);
      residual.set("magnitude", cv::norm(projected - observed));
      view_residuals.call<void>("push", residual);
    }
    residuals.set(observation.id, view_residuals);
  }
  for (const int index : excluded) excluded_ids.call<void>("push", observations[index].id);
  result.set("includedViewIds", included_ids);
  result.set("excludedViewIds", excluded_ids);
  result.set("poses", poses);
  result.set("residuals", residuals);
  return result;
}

cv::Mat camera_matrix_from_result(const val& calibration, int width, int height) {
  const val source = calibration["cameraMatrix"];
  if (bounded_array_length(source, 9, "Camera matrix") != 9) {
    throw std::runtime_error("Invalid camera matrix.");
  }
  cv::Mat matrix(3, 3, CV_64F);
  for (int index = 0; index < 9; ++index) {
    const double value = source[index].as<double>();
    if (!std::isfinite(value)) throw std::runtime_error("Invalid camera matrix.");
    matrix.at<double>(index / 3, index % 3) = value;
  }
  if (matrix.at<double>(0, 0) <= 0.0 || matrix.at<double>(1, 1) <= 0.0) {
    throw std::runtime_error("Invalid camera focal lengths.");
  }
  const val calibrated_size = calibration["imageSize"];
  const double calibrated_width = calibrated_size["width"].as<double>();
  const double calibrated_height = calibrated_size["height"].as<double>();
  if (!std::isfinite(calibrated_width) || !std::isfinite(calibrated_height) ||
      calibrated_width <= 0.0 || calibrated_height <= 0.0) {
    throw std::runtime_error("Invalid calibrated image dimensions.");
  }
  const double scale_x = width / calibrated_width;
  const double scale_y = height / calibrated_height;
  matrix.at<double>(0, 0) *= scale_x;
  matrix.at<double>(0, 1) *= scale_x;
  matrix.at<double>(0, 2) *= scale_x;
  matrix.at<double>(1, 1) *= scale_y;
  matrix.at<double>(1, 2) *= scale_y;
  return matrix;
}

cv::Mat distortion_from_result(const val& calibration, int expected_length) {
  const val source = calibration["distortion"];
  if (bounded_array_length(source, expected_length, "Distortion coefficients") !=
      expected_length) {
    throw std::runtime_error("The distortion coefficient count does not match the lens model.");
  }
  cv::Mat distortion(expected_length, 1, CV_64F);
  for (int index = 0; index < expected_length; ++index) {
    const double value = source[index].as<double>();
    if (!std::isfinite(value)) throw std::runtime_error("Invalid distortion coefficients.");
    distortion.at<double>(index) = value;
  }
  return distortion;
}

val undistort_frame(const val& rgba,
                    int width,
                    int height,
                    const val& calibration,
                    const std::string& preview_mode) {
  std::vector<unsigned char> bytes = copy_bytes(rgba, checked_image_byte_count(width, height));
  cv::Mat source(height, width, CV_8UC4, bytes.data());
  cv::Mat output;
  const std::string model = calibration["model"].as<std::string>();
  const int expected_distortion =
      model == "pinhole-radtan5" ? 5 : model == "fisheye-kb4" ? 4 : 0;
  if (expected_distortion == 0) throw std::runtime_error("Unsupported lens model.");
  if (preview_mode != "full" && preview_mode != "fill") {
    throw std::runtime_error("Unsupported corrected preview mode.");
  }
  cv::Mat camera_matrix = camera_matrix_from_result(calibration, width, height);
  cv::Mat distortion = distortion_from_result(calibration, expected_distortion);
  if (model == "pinhole-radtan5") {
    cv::undistort(source, output, camera_matrix, distortion, camera_matrix);
  } else if (model == "fisheye-kb4") {
    cv::Mat preview_camera_matrix = centered_fisheye_preview_matrix(
        camera_matrix, distortion, cv::Size(width, height),
        preview_mode == "fill" ? 0.0 : 1.0);
    cv::fisheye::undistortImage(source, output, camera_matrix, distortion,
                                preview_camera_matrix, cv::Size(width, height));
  }
  if (output.rows != height || output.cols != width || output.type() != CV_8UC4) {
    throw std::runtime_error("OpenCV returned an invalid undistorted image.");
  }
  if (!output.isContinuous()) output = output.clone();
  val result = val::object();
  result.set("ok", true);
  result.set("width", width);
  result.set("height", height);
  result.set("rgba", copied_uint8_array(output.data, output.total() * output.elemSize()));
  return result;
}

std::vector<cv::Rect> merged_black_rectangles(const cv::Mat& binary) {
  std::map<std::pair<int, int>, cv::Rect> active;
  std::vector<cv::Rect> completed;
  for (int y = 0; y < binary.rows; ++y) {
    std::map<std::pair<int, int>, cv::Rect> next;
    int x = 0;
    while (x < binary.cols) {
      while (x < binary.cols && binary.at<unsigned char>(y, x) > 127) ++x;
      const int start = x;
      while (x < binary.cols && binary.at<unsigned char>(y, x) <= 127) ++x;
      if (start == x) continue;
      const auto key = std::make_pair(start, x - start);
      const auto existing = active.find(key);
      if (existing != active.end()) {
        cv::Rect rectangle = existing->second;
        rectangle.height += 1;
        next.emplace(key, rectangle);
      } else {
        next.emplace(key, cv::Rect(start, y, x - start, 1));
      }
    }
    for (const auto& [key, rectangle] : active) {
      if (next.find(key) == next.end()) completed.push_back(rectangle);
    }
    active = std::move(next);
  }
  for (const auto& entry : active) completed.push_back(entry.second);
  return completed;
}

std::string generate_pattern_svg(const val& pattern) {
  const std::string kind = pattern["kind"].as<std::string>();
  int pixels_per_square = 80;
  int board_width = 0;
  int board_height = 0;
  std::ostringstream board_elements;

  if (kind == "chessboard") {
    const int inner_x = pattern_dimension(pattern, "innerCornersX");
    const int inner_y = pattern_dimension(pattern, "innerCornersY");
    const int squares_x = inner_x + 1;
    const int squares_y = inner_y + 1;
    board_width = squares_x * pixels_per_square;
    board_height = squares_y * pixels_per_square;
    for (int row = 0; row < squares_y; ++row) {
      for (int column = 0; column < squares_x; ++column) {
        if ((row + column) % 2 == 0) {
          board_elements << "<rect x=\"" << column * pixels_per_square << "\" y=\""
                         << row * pixels_per_square << "\" width=\"" << pixels_per_square
                         << "\" height=\"" << pixels_per_square
                         << "\" fill=\"#000\"/>";
        }
      }
    }
  } else if (kind == "charuco") {
    const int squares_x = pattern_dimension(pattern, "squaresX");
    const int squares_y = pattern_dimension(pattern, "squaresY");
    const bool legacy = pattern["legacyPattern"].as<bool>();
    const std::string dictionary_name = pattern["dictionary"].as<std::string>();
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictionary_type(dictionary_name));
    validate_charuco_dictionary(squares_x, squares_y, dictionary);
    const int marker_modules = dictionary.markerSize + 2;
    while (((pixels_per_square * 7) / 10) % marker_modules != 0) {
      pixels_per_square += 10;
    }
    board_width = squares_x * pixels_per_square;
    board_height = squares_y * pixels_per_square;
    cv::aruco::CharucoBoard board(cv::Size(squares_x, squares_y),
                                  kCharucoSquareLength,
                                  kCharucoMarkerLength, dictionary);
    board.setLegacyPattern(legacy);
    cv::Mat image;
    board.generateImage(cv::Size(board_width, board_height), image, 0, 1);
    for (const auto& rectangle : merged_black_rectangles(image)) {
      board_elements << "<rect x=\"" << rectangle.x << "\" y=\""
                     << rectangle.y << "\" width=\"" << rectangle.width
                     << "\" height=\"" << rectangle.height
                     << "\" fill=\"#000\"/>";
    }
  } else {
    throw std::runtime_error("Unsupported calibration pattern.");
  }

  constexpr int margin = 16;
  const int page_width = board_width + margin * 2;
  const int page_height = board_height + margin * 2;
  std::ostringstream svg;
  svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << page_width
      << "\" height=\"" << page_height << "\" viewBox=\"0 0 " << page_width << ' '
      << page_height << "\" shape-rendering=\"crispEdges\">"
      << "<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>"
      << "<g transform=\"translate(" << margin << ' ' << margin << ")\">"
      << "<rect width=\"" << board_width << "\" height=\"" << board_height
      << "\" fill=\"#fff\"/>" << board_elements.str() << "</g>"
      << "</svg>";
  return svg.str();
}

std::string generate_display_pattern_svg(const val& pattern,
                                         int square_pixels,
                                         int marker_pixels) {
  if (square_pixels < 8 || square_pixels > 8192) {
    throw std::runtime_error("Display square size must be between 8 and 8192 pixels.");
  }
  const std::string kind = pattern["kind"].as<std::string>();
  int squares_x = 0;
  int squares_y = 0;
  std::ostringstream board_elements;

  if (kind == "chessboard") {
    const int inner_x = pattern_dimension(pattern, "innerCornersX");
    const int inner_y = pattern_dimension(pattern, "innerCornersY");
    squares_x = inner_x + 1;
    squares_y = inner_y + 1;
    if (squares_x * square_pixels > 32768 || squares_y * square_pixels > 32768) {
      throw std::runtime_error("Display board exceeds the 32768-pixel edge limit.");
    }
    for (int row = 0; row < squares_y; ++row) {
      for (int column = 0; column < squares_x; ++column) {
        if ((row + column) % 2 == 0) {
          board_elements << "<rect x=\"" << column * square_pixels << "\" y=\""
                         << row * square_pixels << "\" width=\"" << square_pixels
                         << "\" height=\"" << square_pixels << "\" fill=\"#000\"/>";
        }
      }
    }
  } else if (kind == "charuco") {
    squares_x = pattern_dimension(pattern, "squaresX");
    squares_y = pattern_dimension(pattern, "squaresY");
    const bool legacy = pattern["legacyPattern"].as<bool>();
    const std::string dictionary_name = pattern["dictionary"].as<std::string>();
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictionary_type(dictionary_name));
    validate_charuco_dictionary(squares_x, squares_y, dictionary);
    if (marker_pixels <= 0 || marker_pixels >= square_pixels) {
      throw std::runtime_error("Display marker size must be positive and smaller than a square.");
    }
    if (marker_pixels % (dictionary.markerSize + 2) != 0) {
      throw std::runtime_error("Display marker size must contain complete marker modules.");
    }
    if (marker_pixels * 10 != square_pixels * 7) {
      throw std::runtime_error("Display marker size must be seven tenths of a square.");
    }
    if (squares_x * square_pixels > 32768 || squares_y * square_pixels > 32768) {
      throw std::runtime_error("Display board exceeds the 32768-pixel edge limit.");
    }
    cv::aruco::CharucoBoard board(
        cv::Size(squares_x, squares_y), 1.0F,
        static_cast<float>(marker_pixels) / static_cast<float>(square_pixels), dictionary);
    board.setLegacyPattern(legacy);
    cv::Mat image;
    board.generateImage(
        cv::Size(squares_x * square_pixels, squares_y * square_pixels), image, 0, 1);
    for (const auto& rectangle : merged_black_rectangles(image)) {
      board_elements << "<rect x=\"" << rectangle.x << "\" y=\"" << rectangle.y
                     << "\" width=\"" << rectangle.width << "\" height=\""
                     << rectangle.height << "\" fill=\"#000\"/>";
    }
  } else {
    throw std::runtime_error("Unsupported calibration pattern.");
  }

  const std::int64_t board_width = static_cast<std::int64_t>(squares_x) * square_pixels;
  const std::int64_t board_height = static_cast<std::int64_t>(squares_y) * square_pixels;
  if (board_width <= 0 || board_height <= 0 || board_width > 32768 || board_height > 32768) {
    throw std::runtime_error("Display board exceeds the 32768-pixel edge limit.");
  }
  std::ostringstream svg;
  svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << board_width
      << "\" height=\"" << board_height << "\" viewBox=\"0 0 " << board_width << ' '
      << board_height << "\" shape-rendering=\"crispEdges\">"
      << "<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>"
      << board_elements.str() << "</svg>";
  return svg.str();
}

std::string opencv_version() { return CV_VERSION; }

}  // namespace

EMSCRIPTEN_BINDINGS(camera_calibration) {
  emscripten::function("getOpenCvVersion", &opencv_version);
  emscripten::function("detectFrame", &detect_frame);
  emscripten::function("solveCalibration", &solve_calibration);
  emscripten::function("undistortFrame", &undistort_frame);
  emscripten::function("generatePatternSvg", &generate_pattern_svg);
  emscripten::function("generateDisplayPatternSvg", &generate_display_pattern_svg);
}
