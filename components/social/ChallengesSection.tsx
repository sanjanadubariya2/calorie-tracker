import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import { toISODate } from "@/lib/dates";
import { getFriendSummaries } from "@/lib/social";
import { SocialFeatureUnavailable } from "@/lib/socialActivity";
import {
  checkInChallenge,
  declineChallenge,
  describeChallengeError,
  getChallengeCatalog,
  getMyChallenges,
  groupChallenges,
  joinChallenge,
  leaveChallenge,
  startChallenge,
  type CatalogEntry,
  type MyChallenge,
} from "@/lib/challenges";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CatalogCard, ChallengeProgressCard } from "./ChallengeCards";
import { ChallengeDetailModal } from "./ChallengeDetailModal";
import { StartChallengeModal, type InvitableFriend } from "./StartChallengeModal";
import type { SocialFocus } from "@/app/(tabs)/friends";

type View_ = "discover" | "joined" | "completed";
type Status = "loading" | "ready" | "error" | "unavailable";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Discover, joined and completed challenges. All progress comes from the server. */
export function ChallengesSection({ focus }: { focus?: SocialFocus | null } = {}) {
  const today = toISODate(new Date());
  const [view, setView] = useState<View_>("discover");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [mine, setMine] = useState<MyChallenge[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [refreshing, setRefreshing] = useState(false);
  // Key of the card with an action in flight, so double taps don't send twice.
  const [busy, setBusy] = useState<string | null>(null);
  // State updates land after a re-render, so two taps in one frame would both
  // see busy === null; the ref closes that gap.
  const inFlight = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState<CatalogEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<MyChallenge | null>(null);

  const load = useCallback(async () => {
    try {
      const [cat, my] = await Promise.all([getChallengeCatalog(), getMyChallenges()]);
      setCatalog(cat);
      setMine(my);
      setStatus("ready");
    } catch (e) {
      setStatus(e instanceof SocialFeatureUnavailable ? "unavailable" : "error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A deep link to a challenge: open it once it's loaded.
  const focusChallenge = focus?.challenge;
  const focusKey = focus?.key;
  useEffect(() => {
    if (!focusChallenge || status !== "ready") return;
    const c = mine.find((x) => x.challenge_id === focusChallenge);
    if (!c) return;
    setView(c.state === "completed" || c.state === "expired" || c.state === "left" ? "completed"
            : c.state === "invited" ? "discover" : "joined");
    setOpenId(c.challenge_id);
  }, [focusChallenge, focusKey, status, mine]);

  async function run(key: string, action: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(key);
    setMessage(null);
    setActionError(null);
    try {
      await action();
      if (success) setMessage(success);
      await load();
      return true;
    } catch (e) {
      const text = describeChallengeError(e);
      setActionError(text);
      setMessage(text);
      await load();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const loadFriends = useCallback(async (): Promise<InvitableFriend[]> => {
    // Only names and avatars are used here.
    const list = await getFriendSummaries(today);
    return list.map((f) => ({ user_id: f.user_id, username: f.username, avatar_url: f.avatar_url }));
  }, [today]);

  const groups = groupChallenges(mine);
  const open = openId ? mine.find((c) => c.challenge_id === openId) ?? null : null;
  const featured = catalog.filter((c) => c.app_challenge_id);
  const others = catalog.filter((c) => !c.app_challenge_id);

  const card = (c: MyChallenge) => (
    <ChallengeProgressCard
      key={c.challenge_id}
      challenge={c}
      today={today}
      busy={busy === c.challenge_id}
      onOpen={() => { setActionError(null); setOpenId(c.challenge_id); }}
      onCheckIn={() => run(c.challenge_id, () => checkInChallenge(c.challenge_id), "Checked in. Nice!")}
      onAccept={() => run(c.challenge_id, () => joinChallenge(c.challenge_id), `Joined “${c.title}”.`)}
      onDecline={() => run(c.challenge_id, () => declineChallenge(c.challenge_id))}
    />
  );

  let body: React.ReactNode;
  if (status === "loading") {
    body = (
      <View testID="challenges-loading">
        {[0, 1, 2].map((i) => <View key={i} style={styles.skeleton} />)}
      </View>
    );
  } else if (status !== "ready") {
    body = (
      <View testID={`challenges-${status}`} style={styles.center}>
        <Text style={styles.emptyTitle}>
          {status === "unavailable" ? "Challenges aren't switched on yet" : "Couldn't load challenges"}
        </Text>
        <Text style={styles.emptyBody}>
          {status === "unavailable" ? "This server hasn't been updated for challenges." : "Pull down to try again."}
        </Text>
      </View>
    );
  } else if (view === "discover") {
    body = (
      <>
        {groups.invited.length > 0 ? (
          <>
            <Text style={styles.section}>Invitations</Text>
            {groups.invited.map(card)}
          </>
        ) : null}
        <Text style={styles.section}>This week</Text>
        <Text style={styles.sectionHint}>Open to everyone. Rest days are built into every target.</Text>
        {featured.map((e) => (
          <CatalogCard
            key={e.template_code}
            entry={e}
            busy={busy === e.template_code}
            onJoin={() => run(e.template_code, () => joinChallenge(e.app_challenge_id as string), `Joined “${e.title}”.`)}
            onStart={() => { setActionError(null); setStarting(e); }}
          />
        ))}
        <Text style={styles.section}>Start your own</Text>
        {others.map((e) => (
          <CatalogCard key={e.template_code} entry={e} onStart={() => { setActionError(null); setStarting(e); }} />
        ))}
      </>
    );
  } else if (view === "joined") {
    const list = [...groups.invited, ...groups.current];
    body = list.length === 0 ? (
      <View testID="joined-empty" style={styles.center}>
        <Text style={styles.emptyIcon}>🎯</Text>
        <Text style={styles.emptyTitle}>No challenges in progress</Text>
        <Text style={styles.emptyBody}>Pick a small, steady habit to try this week.</Text>
        <Pressable testID="joined-discover" style={styles.primary} onPress={() => setView("discover")}>
          <Text style={styles.primaryText}>Browse challenges</Text>
        </Pressable>
      </View>
    ) : (
      <>{list.map(card)}</>
    );
  } else {
    body = groups.completed.length === 0 && groups.past.length === 0 ? (
      <View testID="completed-empty" style={styles.center}>
        <Text style={styles.emptyIcon}>🏁</Text>
        <Text style={styles.emptyTitle}>No finished challenges yet</Text>
        <Text style={styles.emptyBody}>Completed challenges are kept here.</Text>
      </View>
    ) : (
      <>
        {groups.completed.length > 0 ? <Text style={styles.section}>Completed</Text> : null}
        {groups.completed.map(card)}
        {groups.past.length > 0 ? <Text style={styles.section}>Ended</Text> : null}
        {groups.past.map(card)}
      </>
    );
  }

  const counts: Record<View_, number> = {
    discover: 0,
    joined: groups.invited.length + groups.current.length,
    completed: groups.completed.length,
  };

  return (
    <>
      <ScrollView
        testID="challenges-scroll"
        contentContainerStyle={styles.pad}
        refreshControl={
          <RefreshControl tintColor={colors.textPrimary} refreshing={refreshing}
                          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />
        }
      >
        <View style={styles.subtabs}>
          {(["discover", "joined", "completed"] as View_[]).map((v) => (
            <Pressable key={v} testID={`challenges-tab-${v}`} onPress={() => setView(v)}
                       style={[styles.subtab, view === v && styles.subtabActive]}
                       accessibilityRole="tab" accessibilityState={{ selected: view === v }}>
              <Text style={[styles.subtabText, view === v && styles.subtabTextActive]}>
                {v === "discover" ? "Discover" : v === "joined" ? "Joined" : "Completed"}
                {counts[v] > 0 ? ` ${counts[v]}` : ""}
              </Text>
            </Pressable>
          ))}
        </View>
        {message ? <Text testID="challenges-message" style={styles.message}>{message}</Text> : null}
        {body}
        <Text style={styles.footnote}>
          Challenges are about steady habits. There are no calorie, weight or exercise-amount goals, and nobody is ranked.
        </Text>
      </ScrollView>

      <ChallengeDetailModal
        challenge={open}
        today={today}
        busy={open !== null && busy === open.challenge_id}
        error={actionError}
        onClose={() => setOpenId(null)}
        onCheckIn={(c) => run(c.challenge_id, () => checkInChallenge(c.challenge_id), "Checked in. Nice!")}
        onLeave={(c) => setLeaving(c)}
      />
      <StartChallengeModal
        entry={starting}
        loadFriends={loadFriends}
        busy={busy === "start"}
        error={starting ? actionError : null}
        onClose={() => setStarting(null)}
        onStart={async (entry, invite, tomorrow) => {
          const ok = await run("start", () => startChallenge(entry.template_code, invite, tomorrow ? addDays(today, 1) : undefined),
                               `Started “${entry.title}”.`);
          if (ok) { setStarting(null); setView("joined"); }
        }}
      />
      <ConfirmDialog
        visible={leaving !== null}
        title="Leave this challenge?"
        message="Your progress so far won't count any more. You can rejoin while it's still running."
        confirmLabel="Leave"
        onCancel={() => setLeaving(null)}
        onConfirm={async () => {
          const c = leaving;
          setLeaving(null);
          if (!c) return;
          const ok = await run(c.challenge_id, () => leaveChallenge(c.challenge_id), `You left “${c.title}”.`);
          if (ok) setOpenId(null);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pad: { padding: spacing.lg, paddingTop: spacing.sm, flexGrow: 1 },
  subtabs: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  subtab: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.cardBorder, paddingHorizontal: spacing.md, paddingVertical: 6 },
  subtabActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  subtabText: { ...typography.caption, color: colors.textSecondary },
  subtabTextActive: { color: "#0A0A0A" },
  section: { ...typography.label, fontSize: 16, color: colors.textPrimary, marginTop: spacing.md, marginBottom: spacing.xs },
  sectionHint: { ...typography.caption, color: colors.textTertiary, marginBottom: spacing.md },
  message: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.md },
  center: { alignItems: "center", paddingVertical: spacing.xl },
  emptyIcon: { fontSize: 40, marginBottom: spacing.sm },
  emptyTitle: { ...typography.label, fontSize: 16, color: colors.textPrimary, textAlign: "center" },
  emptyBody: { ...typography.caption, color: colors.textSecondary, textAlign: "center", marginTop: spacing.sm, maxWidth: 300 },
  primary: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  primaryText: { ...typography.label, color: "#0A0A0A" },
  skeleton: { height: 120, borderRadius: radius.md, backgroundColor: colors.card, marginBottom: spacing.md },
  footnote: { ...typography.caption, color: colors.textTertiary, textAlign: "center", marginTop: spacing.lg, lineHeight: 17 },
});
