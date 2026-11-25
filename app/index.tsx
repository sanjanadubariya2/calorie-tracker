import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getProfile, syncProfileTimezone } from "@/lib/api";
import { colors } from "@/constants/theme";

export default function Index() {
  const { userId, loading } = useAuth();
  const [checkingProfile, setCheckingProfile] = useState(true);
  const [hasProfile, setHasProfile] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!userId) {
      setCheckingProfile(false);
      return;
    }
    getProfile(userId)
      .then((profile) => {
        setHasProfile(!!profile);
        // Keeps the server's idea of this user's "today" in step with the
        // device. Non-blocking: streaks fall back to lenient bounds if unset.
        if (profile) syncProfileTimezone(userId, profile).catch(() => {});
      })
      .catch(() => setHasProfile(false))
      .finally(() => setCheckingProfile(false));
  }, [userId, loading]);

  if (loading || checkingProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.link} size="large" />
      </View>
    );
  }

  // On web a signed-out visitor is a prospective user, so they get the landing
  // page and its app download. In the installed app they're already past that.
  if (!userId) {
    return <Redirect href={Platform.OS === "web" ? "/landing" : "/(auth)/login"} />;
  }
  if (!hasProfile) return <Redirect href="/onboarding/profile-setup" />;
  return <Redirect href="/(tabs)" />;
}
