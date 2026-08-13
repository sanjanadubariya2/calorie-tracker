import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { getProfile } from "@/lib/api";
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
      .then((profile) => setHasProfile(!!profile))
      .catch(() => setHasProfile(false))
      .finally(() => setCheckingProfile(false));
  }, [userId, loading]);

  if (loading || checkingProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.progressFill} size="large" />
      </View>
    );
  }

  if (!userId) return <Redirect href="/(auth)/login" />;
  if (!hasProfile) return <Redirect href="/onboarding/profile-setup" />;
  return <Redirect href="/(tabs)" />;
}
