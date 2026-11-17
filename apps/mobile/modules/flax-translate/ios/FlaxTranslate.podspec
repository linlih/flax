Pod::Spec.new do |s|
  s.name           = 'FlaxTranslate'
  s.version        = '1.0.0'
  s.summary        = 'System translation (Apple Translation framework) for Flax'
  s.description    = 'System translation (Apple Translation framework) for Flax'
  s.license        = 'MIT'
  s.author         = 'Flax'
  s.homepage       = 'https://example.invalid/flax'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
