#include <algorithm>
#include <cmath>
#include <iomanip>
#include <limits>
#include <map>
#include <numeric>
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

struct Observation {
  std::string id;
  std::vector<cv::Point2f> image_points;
  std::vector<cv::Point3f> object_points;
};

struct SolveState {
  cv::Mat camera_matrix;
  cv::Mat distortion;
  std::vector<cv::Mat> rotation_vectors;
  std::vector<cv::Mat> translation_vectors;
  std::vector<double> errors;
  double rms = std::numeric_limits<double>::quiet_NaN();
};

cv::aruco::PredefinedDictionaryType dictionary_type(const std::string& name) {
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

std::vector<unsigned char> copy_bytes(const val& typed_array) {
  const std::size_t length = typed_array["byteLength"].as<std::size_t>();
  std::vector<unsigned char> bytes(length);
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
  if (!cv::solvePnP(object_points, image_points, camera_matrix, cv::noArray(), rotation_vector,
                    translation_vector, false, cv::SOLVEPNP_ITERATIVE)) {
    return 0.0;
  }
  cv::Mat rotation;
  cv::Rodrigues(rotation_vector, rotation);
  const double normal_z = std::clamp(std::abs(rotation.at<double>(2, 2)), 0.0, 1.0);
  return std::acos(normal_z) * 180.0 / kPi;
}

val detection_result(const std::vector<cv::Point2f>& image_points,
                     const std::vector<cv::Point3f>& object_points,
                     const std::vector<int>& point_ids,
                     int width,
                     int height,
                     int available_corners,
                     bool require_all,
                     double sharpness) {
  const double area_ratio = convex_hull_area(image_points) / static_cast<double>(width * height);
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
    for (const auto& point : image_points) {
      center_x += point.x / width;
      center_y += point.y / height;
    }
    center_x = (center_x - 0.5) / image_points.size();
    center_y = (center_y - 0.5) / image_points.size();
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
  if (width <= 0 || height <= 0) throw std::runtime_error("Invalid image dimensions.");
  std::vector<unsigned char> bytes = copy_bytes(rgba);
  if (bytes.size() != static_cast<std::size_t>(width * height * 4)) {
    throw std::runtime_error("The RGBA buffer size does not match the image dimensions.");
  }
  cv::Mat source(height, width, CV_8UC4, bytes.data());
  cv::Mat gray;
  cv::cvtColor(source, gray, cv::COLOR_RGBA2GRAY);
  const double sharpness = laplacian_variance(gray);
  const std::string kind = pattern["kind"].as<std::string>();

  if (kind == "charuco") {
    const int squares_x = pattern["squaresX"].as<int>();
    const int squares_y = pattern["squaresY"].as<int>();
    const float square_length = pattern["squareLengthMm"].as<float>();
    const float marker_length = pattern["markerLengthMm"].as<float>();
    const std::string dictionary_name = pattern["dictionary"].as<std::string>();
    const bool legacy_pattern = pattern["legacyPattern"].as<bool>();
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictionary_type(dictionary_name));
    cv::aruco::CharucoBoard board(cv::Size(squares_x, squares_y), square_length,
                                  marker_length, dictionary);
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
    const int corners_x = pattern["innerCornersX"].as<int>();
    const int corners_y = pattern["innerCornersY"].as<int>();
    const float square_length = pattern["squareLengthMm"].as<float>();
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
        object_points.emplace_back(column * square_length, row * square_length, 0.0f);
        ids.push_back(row * corners_x + column);
      }
    }
    return detection_result(corners, object_points, ids, width, height,
                            corners_x * corners_y, true, sharpness);
  }

  throw std::runtime_error("Unsupported calibration pattern.");
}

std::vector<Observation> parse_observations(const val& input) {
  const int count = input["length"].as<int>();
  std::vector<Observation> observations;
  observations.reserve(count);
  for (int index = 0; index < count; ++index) {
    const val item = input[index];
    Observation observation;
    observation.id = item["id"].as<std::string>();
    const val image_points = item["imagePoints"];
    const val object_points = item["objectPoints"];
    const int point_count = image_points["length"].as<int>();
    if (point_count != object_points["length"].as<int>() || point_count < 4) {
      throw std::runtime_error("Each calibration view needs matching image and object points.");
    }
    observation.image_points.reserve(point_count);
    observation.object_points.reserve(point_count);
    for (int point_index = 0; point_index < point_count; ++point_index) {
      const val image_point = image_points[point_index];
      const val object_point = object_points[point_index];
      observation.image_points.emplace_back(image_point["x"].as<float>(),
                                            image_point["y"].as<float>());
      observation.object_points.emplace_back(object_point["x"].as<float>(),
                                             object_point["y"].as<float>(),
                                             object_point["z"].as<float>());
    }
    observations.push_back(std::move(observation));
  }
  return observations;
}

double view_error(const std::vector<cv::Point2f>& detected,
                  const std::vector<cv::Point2f>& projected) {
  double squared_error = 0.0;
  for (std::size_t index = 0; index < detected.size(); ++index) {
    const double dx = detected[index].x - projected[index].x;
    const double dy = detected[index].y - projected[index].y;
    squared_error += dx * dx + dy * dy;
  }
  return std::sqrt(squared_error / detected.size());
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

  state.errors.reserve(active.size());
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
    total_squared_error += error * error * image_points[local_index].size();
    total_points += image_points[local_index].size();
  }
  state.rms = std::sqrt(total_squared_error / total_points);
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

val solve_calibration(const val& input,
                      const std::string& model,
                      int width,
                      int height) {
  std::vector<Observation> observations = parse_observations(input);
  if (observations.size() < 12) throw std::runtime_error("At least 12 valid views are required.");
  std::vector<int> active(observations.size());
  std::iota(active.begin(), active.end(), 0);
  std::map<std::string, double> all_errors;
  std::vector<int> excluded;
  SolveState state;
  const double absolute_threshold = model == "pinhole-radtan5" ? 1.5 : 2.0;

  for (int iteration = 0; iteration <= 3; ++iteration) {
    state = solve_subset(observations, active, model, cv::Size(width, height));
    for (std::size_t index = 0; index < active.size(); ++index) {
      all_errors[observations[active[index]].id] = state.errors[index];
    }
    if (iteration == 3 || active.size() <= 12) break;
    const double center = median(state.errors);
    std::vector<double> deviations;
    deviations.reserve(state.errors.size());
    for (const double error : state.errors) deviations.push_back(std::abs(error - center));
    const double threshold = std::max(absolute_threshold, center + 3.0 * median(deviations));
    const auto worst = std::max_element(state.errors.begin(), state.errors.end());
    if (worst == state.errors.end() || *worst <= threshold) break;
    const std::size_t local_index = std::distance(state.errors.begin(), worst);
    excluded.push_back(active[local_index]);
    active.erase(active.begin() + local_index);
  }

  val result = val::object();
  result.set("ok", true);
  result.set("opencvVersion", std::string(CV_VERSION));
  std::vector<double> camera_matrix(state.camera_matrix.begin<double>(),
                                    state.camera_matrix.end<double>());
  std::vector<double> distortion(state.distortion.begin<double>(), state.distortion.end<double>());
  result.set("cameraMatrix", number_array(camera_matrix));
  result.set("distortion", number_array(distortion));
  result.set("rmsReprojectionError", state.rms);

  val errors = val::object();
  for (const auto& [id, error] : all_errors) errors.set(id, error);
  result.set("perViewErrors", errors);

  val included_ids = val::array();
  val excluded_ids = val::array();
  val poses = val::array();
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
  }
  for (const int index : excluded) excluded_ids.call<void>("push", observations[index].id);
  result.set("includedViewIds", included_ids);
  result.set("excludedViewIds", excluded_ids);
  result.set("poses", poses);
  return result;
}

cv::Mat camera_matrix_from_result(const val& calibration, int width, int height) {
  const val source = calibration["cameraMatrix"];
  if (source["length"].as<int>() != 9) throw std::runtime_error("Invalid camera matrix.");
  cv::Mat matrix(3, 3, CV_64F);
  for (int index = 0; index < 9; ++index) matrix.at<double>(index / 3, index % 3) = source[index].as<double>();
  const val calibrated_size = calibration["imageSize"];
  const double scale_x = width / calibrated_size["width"].as<double>();
  const double scale_y = height / calibrated_size["height"].as<double>();
  matrix.at<double>(0, 0) *= scale_x;
  matrix.at<double>(0, 2) *= scale_x;
  matrix.at<double>(1, 1) *= scale_y;
  matrix.at<double>(1, 2) *= scale_y;
  return matrix;
}

cv::Mat distortion_from_result(const val& calibration) {
  const val source = calibration["distortion"];
  const int length = source["length"].as<int>();
  cv::Mat distortion(length, 1, CV_64F);
  for (int index = 0; index < length; ++index) distortion.at<double>(index) = source[index].as<double>();
  return distortion;
}

val undistort_frame(const val& rgba,
                    int width,
                    int height,
                    const val& calibration) {
  std::vector<unsigned char> bytes = copy_bytes(rgba);
  if (bytes.size() != static_cast<std::size_t>(width * height * 4)) {
    throw std::runtime_error("The RGBA buffer size does not match the image dimensions.");
  }
  cv::Mat source(height, width, CV_8UC4, bytes.data());
  cv::Mat output;
  cv::Mat camera_matrix = camera_matrix_from_result(calibration, width, height);
  cv::Mat distortion = distortion_from_result(calibration);
  const std::string model = calibration["model"].as<std::string>();
  if (model == "pinhole-radtan5") {
    cv::undistort(source, output, camera_matrix, distortion, camera_matrix);
  } else if (model == "fisheye-kb4") {
    cv::fisheye::undistortImage(source, output, camera_matrix, distortion, camera_matrix,
                                cv::Size(width, height));
  } else {
    throw std::runtime_error("Unsupported lens model.");
  }
  if (!output.isContinuous()) output = output.clone();
  val result = val::object();
  result.set("ok", true);
  result.set("width", width);
  result.set("height", height);
  result.set("rgba", copied_uint8_array(output.data, output.total() * output.elemSize()));
  return result;
}

std::string xml_escape(const std::string& input) {
  std::string escaped;
  escaped.reserve(input.size());
  for (const char character : input) {
    switch (character) {
      case '&': escaped += "&amp;"; break;
      case '<': escaped += "&lt;"; break;
      case '>': escaped += "&gt;"; break;
      case '"': escaped += "&quot;"; break;
      default: escaped += character;
    }
  }
  return escaped;
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
  for (const auto& [key, rectangle] : active) completed.push_back(rectangle);
  return completed;
}

std::string generate_pattern_svg(const val& pattern) {
  const std::string kind = pattern["kind"].as<std::string>();
  double board_width_mm = 0.0;
  double board_height_mm = 0.0;
  std::ostringstream board_elements;
  board_elements << std::fixed << std::setprecision(5);

  if (kind == "chessboard") {
    const int inner_x = pattern["innerCornersX"].as<int>();
    const int inner_y = pattern["innerCornersY"].as<int>();
    const double square = pattern["squareLengthMm"].as<double>();
    const int squares_x = inner_x + 1;
    const int squares_y = inner_y + 1;
    board_width_mm = squares_x * square;
    board_height_mm = squares_y * square;
    for (int row = 0; row < squares_y; ++row) {
      for (int column = 0; column < squares_x; ++column) {
        if ((row + column) % 2 == 0) {
          board_elements << "<rect x=\"" << column * square << "\" y=\"" << row * square
                         << "\" width=\"" << square << "\" height=\"" << square
                         << "\" fill=\"#000\"/>";
        }
      }
    }
  } else if (kind == "charuco") {
    const int squares_x = pattern["squaresX"].as<int>();
    const int squares_y = pattern["squaresY"].as<int>();
    const float square = pattern["squareLengthMm"].as<float>();
    const float marker = pattern["markerLengthMm"].as<float>();
    const bool legacy = pattern["legacyPattern"].as<bool>();
    const std::string dictionary_name = pattern["dictionary"].as<std::string>();
    board_width_mm = squares_x * square;
    board_height_mm = squares_y * square;
    cv::aruco::Dictionary dictionary =
        cv::aruco::getPredefinedDictionary(dictionary_type(dictionary_name));
    cv::aruco::CharucoBoard board(cv::Size(squares_x, squares_y), square, marker, dictionary);
    board.setLegacyPattern(legacy);
    cv::Mat image;
    constexpr int pixels_per_square = 80;
    board.generateImage(cv::Size(squares_x * pixels_per_square,
                                 squares_y * pixels_per_square),
                        image, 0, 1);
    const auto rectangles = merged_black_rectangles(image);
    const double scale_x = board_width_mm / image.cols;
    const double scale_y = board_height_mm / image.rows;
    for (const auto& rectangle : rectangles) {
      board_elements << "<rect x=\"" << rectangle.x * scale_x << "\" y=\""
                     << rectangle.y * scale_y << "\" width=\"" << rectangle.width * scale_x
                     << "\" height=\"" << rectangle.height * scale_y
                     << "\" fill=\"#000\"/>";
    }
  } else {
    throw std::runtime_error("Unsupported calibration pattern.");
  }

  constexpr double margin = 12.0;
  const double page_width = std::max(board_width_mm + margin * 2.0, 124.0);
  const double page_height = board_height_mm + 36.0;
  const double board_x = (page_width - board_width_mm) / 2.0;
  const double ruler_x = (page_width - 100.0) / 2.0;
  const double ruler_y = board_height_mm + 24.0;
  std::ostringstream svg;
  svg << std::fixed << std::setprecision(5)
      << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << page_width
      << "mm\" height=\"" << page_height << "mm\" viewBox=\"0 0 " << page_width << ' '
      << page_height << "\" shape-rendering=\"crispEdges\">"
      << "<rect width=\"100%\" height=\"100%\" fill=\"#fff\"/>"
      << "<g transform=\"translate(" << board_x << ' ' << margin << ")\">"
      << "<rect width=\"" << board_width_mm << "\" height=\"" << board_height_mm
      << "\" fill=\"#fff\"/>" << board_elements.str() << "</g>"
      << "<g stroke=\"#000\" fill=\"#000\" font-family=\"sans-serif\" font-size=\"3\">"
      << "<line x1=\"" << ruler_x << "\" y1=\"" << ruler_y << "\" x2=\""
      << ruler_x + 100.0 << "\" y2=\"" << ruler_y << "\" stroke-width=\"0.5\"/>"
      << "<line x1=\"" << ruler_x << "\" y1=\"" << ruler_y - 2.0 << "\" x2=\""
      << ruler_x << "\" y2=\"" << ruler_y + 2.0 << "\" stroke-width=\"0.5\"/>"
      << "<line x1=\"" << ruler_x + 100.0 << "\" y1=\"" << ruler_y - 2.0
      << "\" x2=\"" << ruler_x + 100.0 << "\" y2=\"" << ruler_y + 2.0
      << "\" stroke-width=\"0.5\"/>"
      << "<text x=\"" << page_width / 2.0 << "\" y=\"" << ruler_y + 6.0
      << "\" text-anchor=\"middle\">100 mm — print at actual size</text></g>"
      << "</svg>";
  return svg.str();
}

std::string opencv_version() { return CV_VERSION; }

}  // namespace

EMSCRIPTEN_BINDINGS(lensbench_calibration) {
  emscripten::function("getOpenCvVersion", &opencv_version);
  emscripten::function("detectFrame", &detect_frame);
  emscripten::function("solveCalibration", &solve_calibration);
  emscripten::function("undistortFrame", &undistort_frame);
  emscripten::function("generatePatternSvg", &generate_pattern_svg);
}
