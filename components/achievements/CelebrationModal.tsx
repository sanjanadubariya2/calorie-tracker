import React, { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";
import type { Achievement } from "@/lib/achievements";

interface Props {
  /** Achievements to celebrate, shown one at a time. */
  queue: Achievement[];
  /** Called with the codes that were shown, once the last one is dismissed. */
  onDone: (codes: string[]) => void;
}

const CONFETTI_COLORS = [colors.progressFill, colors.badgeActive, colors.carb, colors.fat, colors.chartPast];
const PIECES = 18;

/** A short, cheerful celebration: the badge pops in and confetti falls (skipped with reduced motion). */
export function CelebrationModal({ queue, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const scale = useRef(new Animated.Value(0.3)).current;
  const fall = useRef(new Animated.Value(0)).current;
  const current = queue[index];

  useEffect(() => {
    let live = true;
    // Not every platform returns a promise here (or implements it at all).
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then((v) => { if (live) setReduceMotion(Boolean(v)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const code = current?.code;
  useEffect(() => {
    if (!code) return;
    if (reduceMotion) {
      scale.setValue(1);
      return;
    }
    scale.setValue(0.3);
    fall.setValue(0);
    const anim = Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 80, useNativeDriver: true }),
      Animated.timing(fall, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [code, reduceMotion, scale, fall]);

  const pieces = useMemo(
    () => Array.from({ length: PIECES }, (_, i) => ({
      left: `${(i * 53) % 100}%` as const,
      drift: ((i * 37) % 60) - 30,
      size: 6 + (i % 3) * 3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      delay: (i % 6) * 0.08,
    })),
    []
  );

  if (!current) return null;
  const last = index >= queue.length - 1;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onDone(queue.map((a) => a.code))}>
      <View style={styles.backdrop} testID="celebration">
        {!reduceMotion
          ? pieces.map((p, i) => (
              <Animated.View
                key={i}
                pointerEvents="none"
                style={[styles.piece, {
                  left: p.left, width: p.size, height: p.size * 1.6, backgroundColor: p.color,
                  opacity: fall.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0] }),
                  transform: [
                    { translateY: fall.interpolate({ inputRange: [0, 1], outputRange: [-40, 520 + p.delay * 200] }) },
                    { translateX: fall.interpolate({ inputRange: [0, 1], outputRange: [0, p.drift] }) },
                    { rotate: fall.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${180 + i * 20}deg`] }) },
                  ],
                }]}
              />
            ))
          : null}
        <View style={styles.card} accessibilityLiveRegion="polite"
              accessibilityLabel={`Achievement unlocked: ${current.title}. ${current.description}`}>
          <Text style={styles.kicker}>Achievement unlocked</Text>
          <Animated.View style={[styles.badge, { transform: [{ scale }] }]}>
            <Text style={styles.icon}>{current.icon}</Text>
          </Animated.View>
          <Text style={styles.title}>{current.title}</Text>
          <Text style={styles.body}>{current.description}</Text>
          {queue.length > 1 ? <Text style={styles.count}>{index + 1} of {queue.length}</Text> : null}
          <Pressable
            testID="celebration-next"
            style={styles.button}
            onPress={() => (last ? onDone(queue.map((a) => a.code)) : setIndex((i) => i + 1))}
          >
            <Text style={styles.buttonText}>{last ? "Nice!" : "Next"}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(19,32,26,0.45)", alignItems: "center", justifyContent: "center", padding: spacing.lg, overflow: "hidden" },
  piece: { position: "absolute", top: 0, borderRadius: 2 },
  card: {
    width: "100%", maxWidth: 360, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg,
    alignItems: "center", borderWidth: 1, borderColor: colors.cardBorder,
  },
  kicker: { ...typography.caption, color: colors.warning, textTransform: "uppercase", letterSpacing: 1 },
  badge: {
    width: 104, height: 104, borderRadius: 52, backgroundColor: colors.pillBackground, borderWidth: 3,
    borderColor: colors.badgeActive, alignItems: "center", justifyContent: "center", marginVertical: spacing.lg,
  },
  icon: { fontSize: 52 },
  title: { ...typography.title, color: colors.textPrimary, textAlign: "center" },
  body: { ...typography.body, fontSize: 15, color: colors.textSecondary, textAlign: "center", marginTop: spacing.sm },
  count: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.md },
  button: { backgroundColor: colors.progressFill, borderRadius: radius.pill, paddingVertical: spacing.md, alignSelf: "stretch", alignItems: "center", marginTop: spacing.lg },
  buttonText: { ...typography.label, color: colors.onAccent },
});
