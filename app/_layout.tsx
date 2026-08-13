import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { AuthProvider } from "@/lib/auth-context";
import { DemoModeBanner } from "@/components/DemoModeBanner";
import { colors } from "@/constants/theme";

export default function RootLayout() {
  return (
    <AuthProvider>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <StatusBar style="light" />
        <DemoModeBanner />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" />
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
            name="modals/meal-types"
            options={{ presentation: "modal", headerShown: false }}
          />
          <Stack.Screen
            name="modals/about-nutrition"
            options={{ presentation: "modal", headerShown: false }}
          />
        </Stack>
      </View>
    </AuthProvider>
  );
}
