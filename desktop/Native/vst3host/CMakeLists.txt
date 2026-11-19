# drumbort_vst3 — libreria nativa che ospita plugin VST 3 (effetti) per il motore C# di DrumBort.
# L'SDK VST 3 (licenza MIT dalla versione 3.8) va scaricato in VST3_SDK_ROOT:
#   git clone --depth 1 --branch v3.8.0_build_66 https://github.com/steinbergmedia/vst3sdk
#   (cd vst3sdk && git submodule update --init --depth 1 base pluginterfaces public.sdk cmake)
#   cmake -B build -DVST3_SDK_ROOT=$PWD/vst3sdk && cmake --build build --config Release
cmake_minimum_required(VERSION 3.19)
project(drumbort_vst3 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(VST3_SDK_ROOT "" CACHE PATH "Cartella dell'SDK VST 3")
option(DRUMBORT_VST3_SAMPLES "Compila anche i plugin di esempio dell'SDK (test)" OFF)

set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ${DRUMBORT_VST3_SAMPLES} CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
add_subdirectory(${VST3_SDK_ROOT} vst3sdk EXCLUDE_FROM_ALL)

# Caricamento dei moduli: implementazione della piattaforma (non inclusa in sdk_hosting)
if(WIN32)
  set(DBV_MODULE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp)
elseif(APPLE)
  set(DBV_MODULE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm)
else()
  set(DBV_MODULE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()
add_library(drumbort_vst3 SHARED vst3host.cpp ${DBV_MODULE}
  ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp
  ${VST3_SDK_ROOT}/public.sdk/source/common/memorystream.cpp)
target_link_libraries(drumbort_vst3 PRIVATE sdk_hosting sdk_common)
if(UNIX AND NOT APPLE)
  target_link_libraries(drumbort_vst3 PRIVATE dl)
endif()
if(APPLE)
  target_link_libraries(drumbort_vst3 PRIVATE "-framework CoreFoundation")
endif()
target_include_directories(drumbort_vst3 PRIVATE ${VST3_SDK_ROOT})
if(MSVC)
  set_property(TARGET drumbort_vst3 PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
if(DRUMBORT_VST3_SAMPLES)
  add_custom_target(samples ALL DEPENDS adelay)
endif()
