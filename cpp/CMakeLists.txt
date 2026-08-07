cmake_minimum_required(VERSION 3.22)
project(lensbench_calibration_wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This target must be configured with emcmake for WebAssembly.")
endif()

find_package(OpenCV 4.13 REQUIRED COMPONENTS core imgproc calib3d objdetect)

add_executable(calibration calibration_bindings.cpp)
target_include_directories(calibration PRIVATE ${OpenCV_INCLUDE_DIRS})
target_link_libraries(calibration PRIVATE ${OpenCV_LIBS})
target_compile_options(calibration PRIVATE -O3 -msimd128 -fexceptions)

target_link_options(calibration PRIVATE
  --bind
  -O3
  -msimd128
  "-sWASM=1"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createCalibrationModule"
  "-sENVIRONMENT=worker"
  "-sFILESYSTEM=0"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=67108864"
  "-sMAXIMUM_MEMORY=536870912"
  "-sNO_EXIT_RUNTIME=1"
  "-sASSERTIONS=0"
  "-sDISABLE_EXCEPTION_CATCHING=0"
  "-sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount"
)

set_target_properties(calibration PROPERTIES SUFFIX ".js")
