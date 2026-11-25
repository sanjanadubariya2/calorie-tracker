import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { useFonts } from "expo-font";
import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { AuthProvider } from "@/lib/auth-context";
import { AssistantProvider } from "@/lib/assistant-context";
import { DemoModeBanner } from "@/components/DemoModeBanner";
import { colors } from "@/constants/theme";

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });
  // A font that fails to load falls back to the system font rather than blocking the app.
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  return (
    <AuthProvider>
      {/* Above the navigator so the assistant's conversation survives switching tabs. */}
      <AssistantProvider>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <StatusBar style="dark" />
        <DemoModeBanner />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="landing" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="onboarding/profile-setup" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="modals/add-food"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/meal-detail"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/edit-social-profile"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/meal-types"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/about-nutrition"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/achievements"
            options={{ presentation: "modal", headerShown: false }}
          />
        </Stack>
      </View>
      </AssistantProvider>
    </AuthProvider>
  );
}
