import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MOCK_MODE } from "@/lib/supabase";
import { colors, spacing, typography } from "@/constants/theme";

/**
 * MOCK_MODE turns on whenever Supabase credentials are absent — including in a
 * production build where they were simply forgotten. In that state sign-in
 * accepts any password and data never leaves the device, so a deployed build
 * must say so rather than looking like a working account system.
 */
export function DemoModeBanner() {
  if (!MOCK_MODE) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        Demo mode — data is stored on this device only and sign-in is not secured.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.badgeActive,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  text: {
    ...typography.caption,
    color: colors.onAccent,
    textAlign: "center",
  },
});
