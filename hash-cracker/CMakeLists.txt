cmake_minimum_required(VERSION 3.20)

project(zenless_hash_cracker LANGUAGES CXX)

find_package(Threads REQUIRED)

add_executable(zenless-hash-cracker src/main.cpp)
target_compile_features(zenless-hash-cracker PRIVATE cxx_std_17)
target_link_libraries(zenless-hash-cracker PRIVATE Threads::Threads)

# Multi-config generators (Visual Studio) normally insert a Release/Debug
# directory while Make/Ninja do not. Keep one launcher path on every platform.
set_target_properties(zenless-hash-cracker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
foreach(config Debug Release RelWithDebInfo MinSizeRel)
  string(TOUPPER "${config}" config_upper)
  set_target_properties(zenless-hash-cracker PROPERTIES
    "RUNTIME_OUTPUT_DIRECTORY_${config_upper}" "${CMAKE_BINARY_DIR}/bin"
  )
endforeach()

if(MSVC)
  target_compile_options(zenless-hash-cracker PRIVATE /W4)
else()
  target_compile_options(zenless-hash-cracker PRIVATE -Wall -Wextra -Wpedantic -O3)
endif()
