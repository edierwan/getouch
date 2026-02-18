# Add project specific ProGuard rules here.
-keepattributes Signature
-keepattributes *Annotation*

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }

# Gson
-keepattributes SerializedName
-keep class co.getouch.smsgateway.network.** { *; }
-keep class co.getouch.smsgateway.data.** { *; }

# Room
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
