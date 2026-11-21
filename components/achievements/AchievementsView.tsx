import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { SocialFeatureUnavailable } from "@/lib/socialActivity";
import {
  achievementHistory,
  formatUnlockDate,
  getMyAchievements,
  getStreakSummary,
  groupByCategory,
  nextMilestone,
  progressLabel,
  streakMessage,
  type Achievement,
  type StreakSummary,
} from "@/lib/achievements";
import { AchievementCelebration } from "./AchievementCelebration";

type Status = "loading" | "ready" | "error" | "unavailable";
type Tab = "badges" | "history";

function Bar({ value, max, color = colors.progressFill }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: color }]} />
    </View>
  );
}

function Badge({ a }: { a: Achievement }) {
  const unlocked = Boolean(a.unlocked_at);
  return (
    <View testID={`badge-${a.code}`} style={[styles.badge, !unlocked && styles.badgeLocked]}
          accessible accessibilityLabel={`${a.title}. ${unlocked ? "Unlocked" : `Locked, ${progressLabel(a)}`}`}>
      <View style={[styles.badgeIcon, unlocked && styles.badgeIconOn]}>
        <Text style={[styles.badgeEmoji, !unlocked && styles.dim]}>{unlocked ? a.icon : "🔒"}</Text>
      </View>
      <Text style={styles.badgeTitle} numberOfLines={2}>{a.title}</Text>
      {unlocked ? (
        <Text style={styles.badgeMeta}>{formatUnlockDate(a.unlocked_at as string)}</Text>
      ) : (
        <>
          <Text style={styles.badgeMeta} numberOfLines={2}>{a.description}</Text>
          <View style={{ alignSelf: "stretch", marginTop: spacing.xs }}><Bar value={a.progress} max={a.threshold} /></View>
          <Text style={styles.badgeProgress}>{progressLabel(a)}</Text>
        </>
      )}
    </View>
  );
}

/** Streaks, the next milestone, all badges (locked ones previewed) and unlock history. */
export function AchievementsView() {
  const [list, setList] = useState<Achievement[]>([]);
  const [summary, setSummary] = useState<StreakSummary | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("badges");

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([getMyAchievements(), getStreakSummary()]);
      setList(a);
      setSummary(s);
      setStatus("ready");
    } catch (e) {
      setStatus(e instanceof SocialFeatureUnavailable ? "unavailable" : "error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (status === "loading") {
    return <View style={styles.center} testID="achievements-loading"><ActivityIndicator color={colors.progressFill} size="large" /></View>;
  }
  if (status !== "ready") {
    return (
      <View style={styles.center} testID={`achievements-${status}`}>
        <Text style={styles.emptyTitle}>{status === "unavailable" ? "Achievements aren't switched on yet" : "Couldn't load achievements"}</Text>
        {status === "error" ? (
          <Pressable testID="achievements-retry" style={styles.primary} onPress={() => { setStatus("loading"); load(); }}>
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const unlocked = list.filter((a) => a.unlocked_at).length;
  const next = nextMilestone(list);
  const history = achievementHistory(list);

  return (
    <ScrollView
      testID="achievements"
      contentContainerStyle={styles.pad}
      refreshControl={<RefreshControl tintColor={colors.textPrimary} refreshing={refreshing}
                                      onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      {summary ? (
        <View style={styles.card} testID="streak-card">
          <View style={styles.streakRow}>
            <View style={styles.streakMain}>
              <Text style={styles.streakNumber}>{summary.current_streak}</Text>
              <Text style={styles.streakUnit}>day streak</Text>
            </View>
            <View style={styles.stats}>
              <Stat label="Best" value={`${summary.longest_streak} days`} />
              <Stat label="Days logged" value={String(summary.logged_days)} />
              <Stat label="Check-ins this week" value={String(summary.checkins_this_week)} />
              <Stat label="Challenge weeks in a row" value={String(summary.challenge_week_run)} />
            </View>
          </View>
          <Text style={styles.streakMessage} testID="streak-message">{streakMessage(summary)}</Text>
        </View>
      ) : null}

      {next ? (
        <View style={styles.card} testID="next-milestone">
          <Text style={styles.kicker}>Next up</Text>
          <View style={styles.nextRow}>
            <Text style={styles.nextIcon}>{next.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.nextTitle}>{next.title}</Text>
              <Text style={styles.nextBody}>{next.description}</Text>
            </View>
          </View>
          <Bar value={next.progress} max={next.threshold} />
          <Text style={styles.badgeProgress}>{progressLabel(next)}</Text>
        </View>
      ) : (
        <View style={styles.card}><Text style={styles.nextTitle}>Every achievement unlocked. Amazing!</Text></View>
      )}

      <View style={styles.tabs}>
        {(["badges", "history"] as Tab[]).map((t) => (
          <Pressable key={t} testID={`achievements-tab-${t}`} onPress={() => setTab(t)}
                     style={[styles.tab, tab === t && styles.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]}>
              {t === "badges" ? `Badges ${unlocked}/${list.length}` : "History"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "badges" ? (
        groupByCategory(list).map((g) => (
          <View key={g.category}>
            <Text style={styles.section}>{g.label}</Text>
            <View style={styles.grid}>{g.items.map((a) => <Badge key={a.code} a={a} />)}</View>
          </View>
        ))
      ) : history.length === 0 ? (
        <Text style={styles.empty} testID="history-empty">Your unlocked achievements will be listed here.</Text>
      ) : (
        history.map((a) => (
          <View key={a.code} style={styles.historyRow} testID={`history-${a.code}`}>
            <Text style={styles.historyIcon}>{a.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.nextTitle}>{a.title}</Text>
              <Text style={styles.badgeMeta}>{formatUnlockDate(a.unlocked_at as string)}</Text>
            </View>
          </View>
        ))
      )}

      <Text style={styles.footnote}>
        Achievements count meals logged on the day (or the next) and challenges you complete. Missing a day never
        takes anything away.
      </Text>
      <AchievementCelebration onCelebrated={load} />
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: spacing.lg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  streakRow: { flexDirection: "row", gap: spacing.lg, alignItems: "center" },
  streakMain: { alignItems: "center", minWidth: 90 },
  streakNumber: { ...typography.hero, color: colors.progressFill },
  streakUnit: { ...typography.caption, color: colors.textSecondary },
  stats: { flex: 1, flexDirection: "row", flexWrap: "wrap", rowGap: spacing.sm },
  stat: { width: "50%" },
  statValue: { ...typography.label, color: colors.textPrimary },
  statLabel: { ...typography.caption, fontSize: 11, color: colors.textTertiary },
  streakMessage: { ...typography.body, fontSize: 14, color: colors.textSecondary, marginTop: spacing.md, lineHeight: 20 },
  kicker: { ...typography.caption, color: colors.badgeActive, textTransform: "uppercase", letterSpacing: 1 },
  nextRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginVertical: spacing.md },
  nextIcon: { fontSize: 36 },
  nextTitle: { ...typography.label, fontSize: 16, color: colors.textPrimary },
  nextBody: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.progressTrack, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill },
  tabs: { flexDirection: "row", gap: spacing.sm, marginVertical: spacing.sm },
  tab: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.md, paddingVertical: 6 },
  tabOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  tabText: { ...typography.caption, color: colors.textSecondary },
  tabTextOn: { color: "#0A0A0A" },
  section: { ...typography.label, fontSize: 16, color: colors.textPrimary, marginTop: spacing.md, marginBottom: spacing.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  badge: { width: "48%", flexGrow: 1, backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, alignItems: "center" },
  badgeLocked: { backgroundColor: "#0E0E0E", borderWidth: 1, borderColor: colors.divider },
  badgeIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.pillBackground, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm },
  badgeIconOn: { borderWidth: 2, borderColor: colors.badgeActive },
  badgeEmoji: { fontSize: 28 },
  dim: { opacity: 0.5 },
  badgeTitle: { ...typography.label, color: colors.textPrimary, textAlign: "center" },
  badgeMeta: { ...typography.caption, fontSize: 11, color: colors.textTertiary, textAlign: "center", marginTop: 2 },
  badgeProgress: { ...typography.caption, fontSize: 11, color: colors.textSecondary, marginTop: spacing.xs, textAlign: "center" },
  historyRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  historyIcon: { fontSize: 28 },
  empty: { ...typography.caption, color: colors.textSecondary, textAlign: "center", paddingVertical: spacing.xl },
  emptyTitle: { ...typography.label, fontSize: 16, color: colors.textPrimary, textAlign: "center" },
  primary: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  primaryText: { ...typography.label, color: "#0A0A0A" },
  footnote: { ...typography.caption, color: colors.textTertiary, textAlign: "center", marginTop: spacing.lg, lineHeight: 17 },
});
