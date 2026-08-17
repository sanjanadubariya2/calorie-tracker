import React from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { colors, radius, spacing, typography } from "@/constants/theme";

// Direct APK link from the latest EAS build. Update this when a new build
// replaces it — see README section 5.
const APK_URL = "https://expo.dev/artifacts/eas/guPjEj4opw2lUgx1Glb64lJESZaGchH_DUqYebEVRZM.apk";

const FEATURES = [
  {
    accent: colors.progressFill,
    title: "Log in seconds",
    body: "Search a million foods, or re-log yesterday's breakfast with one tap. Six meal slots, no fuss.",
  },
  {
    accent: colors.carb,
    title: "See the whole picture",
    body: "Calories and macros side by side, with daily, weekly, and monthly trends against your own target.",
  },
  {
    accent: colors.fat,
    title: "Built around your numbers",
    body: "Your target comes from your body and your goal — not a one-size-fits-all default.",
  },
  {
    accent: colors.protein,
    title: "Better together",
    body: "Connect with friends by username, compare progress, and share a report anywhere.",
  },
];

export default function LandingScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.nav}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>Calorie Tracker</Text>
          <View style={styles.brandDot} />
        </View>
        <Pressable style={styles.navButton} onPress={() => router.push("/(auth)/login")}>
          <Text style={styles.navButtonText}>Log in</Text>
        </Pressable>
      </View>

      <View style={styles.hero}>
        <Text style={[styles.heroTitle, isWide && styles.heroTitleWide]}>
          <Text style={styles.heroMuted}>Eating well starts with{"\n"}knowing what you </Text>
          <Text style={styles.heroBright}>actually</Text>
          <Text style={styles.heroMuted}> eat</Text>
        </Text>

        <Text style={styles.heroSub}>
          Track every meal, watch your macros balance out, and keep the streak alive — with friends
          who are doing the same.
        </Text>

        <View style={[styles.ctaRow, !isWide && styles.ctaRowNarrow]}>
          <Pressable style={styles.primaryCta} onPress={() => Linking.openURL(APK_URL)}>
            <Text style={styles.primaryCtaText}>Download for Android</Text>
          </Pressable>
          <Pressable style={styles.secondaryCta} onPress={() => router.push("/(auth)/signup")}>
            <Text style={styles.secondaryCtaText}>Use it in the browser</Text>
          </Pressable>
        </View>

        <Text style={styles.ctaNote}>
          Free, no ads. The Android build installs directly — no Play Store needed.
        </Text>
      </View>

      <View style={[styles.featureGrid, isWide && styles.featureGridWide]}>
        {FEATURES.map((f) => (
          <View key={f.title} style={[styles.featureCard, isWide && styles.featureCardWide]}>
            <View style={[styles.featureAccent, { backgroundColor: f.accent }]} />
            <Text style={styles.featureTitle}>{f.title}</Text>
            <Text style={styles.featureBody}>{f.body}</Text>
          </View>
        ))}
      </View>

      <View style={styles.installCard}>
        <Text style={styles.installTitle}>Installing on Android</Text>
        {[
          "Tap Download for Android above — the .apk lands in your Downloads.",
          "Open it and allow installs from your browser when prompted.",
          "Sign up, answer a few questions, and your daily target is ready.",
        ].map((step, i) => (
          <View key={step} style={styles.stepRow}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>{i + 1}</Text>
            </View>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
        <Text style={styles.installNote}>
          The unknown-sources warning is normal for any app installed outside the Play Store.
        </Text>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Calorie Tracker · Food data from Open Food Facts · Not medical advice
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingBottom: spacing.xl,
    maxWidth: 1080,
    width: "100%",
    alignSelf: "center",
  },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  brand: {
    ...typography.title,
    color: colors.textPrimary,
  },
  brandDot: {
    width: 10,
    height: 10,
    backgroundColor: colors.progressFill,
    borderRadius: 2,
  },
  navButton: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.pillBackground,
  },
  navButtonText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  hero: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: 56,
    paddingBottom: spacing.xl,
  },
  heroTitle: {
    fontSize: 38,
    lineHeight: 46,
    fontWeight: "700",
    textAlign: "center",
  },
  heroTitleWide: {
    fontSize: 62,
    lineHeight: 72,
  },
  heroMuted: {
    color: colors.textTertiary,
  },
  heroBright: {
    color: colors.progressFill,
  },
  heroSub: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.lg,
    maxWidth: 560,
    lineHeight: 24,
  },
  ctaRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  ctaRowNarrow: {
    flexDirection: "column",
    alignSelf: "stretch",
  },
  primaryCta: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  primaryCtaText: {
    ...typography.label,
    color: "#0A0A0A",
  },
  secondaryCta: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  secondaryCtaText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  ctaNote: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.md,
    textAlign: "center",
  },
  featureGrid: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  featureGridWide: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  featureCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  featureCardWide: {
    flex: 1,
    minWidth: 220,
  },
  featureAccent: {
    width: 32,
    height: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  featureTitle: {
    ...typography.title,
    fontSize: 18,
    color: colors.textPrimary,
  },
  featureBody: {
    ...typography.body,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 21,
  },
  installCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    margin: spacing.lg,
  },
  installTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.pillBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
  },
  stepText: {
    ...typography.body,
    fontSize: 14,
    color: colors.textSecondary,
    flex: 1,
    lineHeight: 21,
  },
  installNote: {
    ...typography.caption,
    color: colors.textTertiary,
  },
  footer: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  footerText: {
    ...typography.caption,
    color: colors.textTertiary,
    textAlign: "center",
  },
});
