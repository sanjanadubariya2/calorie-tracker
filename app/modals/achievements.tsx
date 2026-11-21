import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { colors, spacing, typography } from "@/constants/theme";
import { AchievementsView } from "@/components/achievements/AchievementsView";

export default function AchievementsModal() {
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Achievements</Text>
        <Pressable testID="achievements-close" onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </Pressable>
      </View>
      <AchievementsView />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg,
  },
  title: { ...typography.title, color: colors.textPrimary },
  close: { ...typography.label, color: colors.progressFill },
});
