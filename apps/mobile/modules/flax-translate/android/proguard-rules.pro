# ML Kit 启动时按类名反射创建这些注册类；发布版的 R8 会把没人直接调用的构造函数删掉，ML Kit 就起不来
-keep class com.google.mlkit.** { *; }
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
