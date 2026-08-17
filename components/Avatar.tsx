import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { colors } from "@/constants/theme";

interface Props {
  /** Stable identity — user id or username. Same seed always yields the same avatar. */
  seed: string;
  /** Uploaded photo. Falls back to the generated avatar when absent. */
  photoUrl?: string | null;
  /** Initial drawn over the generated avatar. */
  label?: string;
  size?: number;
}

// Distinct hues that all read clearly on the near-black background.
const PALETTE = [
  ["#7ED321", "#2E7D0E"],
  ["#B48CF2", "#5B3B9B"],
  ["#F28C6A", "#9B4526"],
  ["#F4D35E", "#9A7E15"],
  ["#4FA8F0", "#1B5C99"],
  ["#F26666", "#992F2F"],
  ["#4FD1C5", "#1A7F76"],
  ["#E879C7", "#8E3771"],
];

// FNV-1a. Small, dependency-free, and spreads similar seeds ("user1"/"user2")
// into unrelated buckets — which a simple char-sum would not.
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Every user gets a distinct generated avatar with no upload required: colour
 * pair, rotation, and a 4-blob arrangement are all derived from the seed, giving
 * 8 × 8 × 16 combinations before the initial is drawn on top.
 */
export function Avatar({ seed, photoUrl, label, size = 44 }: Props) {
  if (photoUrl) {
    return (
      <Image
        source={{ uri: photoUrl }}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        accessibilityIgnoresInvertColors
      />
    );
  }

  const hash = hashSeed(seed || "anon");
  // Unsigned shifts throughout: `>>` is signed in JS, so a hash above 2^31
  // yields negative indices and collapses the variety.
  const [light, dark] = PALETTE[hash % PALETTE.length];
  // 1–15 keeps at least one blob lit, so no avatar is a blank circle.
  const variant = ((hash >>> 3) % 15) + 1;
  const rotation = ((hash >>> 7) % 4) * 90;
  const scale = [0.52, 0.62, 0.74][(hash >>> 11) % 3];

  const blobSize = size * scale;
  // Four corner positions; the variant bitmask decides which are filled.
  const corners = [
    { top: 0, left: 0 },
    { top: 0, right: 0 },
    { bottom: 0, left: 0 },
    { bottom: 0, right: 0 },
  ];

  return (
    <View
      style={[
        styles.wrap,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: dark },
      ]}
    >
      <View style={[styles.inner, { transform: [{ rotate: `${rotation}deg` }] }]}>
        {corners.map((pos, i) => {
          if ((variant & (1 << i)) === 0) return null;
          return (
            <View
              key={i}
              style={[
                styles.blob,
                pos,
                { width: blobSize, height: blobSize, borderRadius: blobSize / 2, backgroundColor: light },
              ]}
            />
          );
        })}
      </View>

      {label ? (
        <Text style={[styles.label, { fontSize: size * 0.36 }]}>{label.charAt(0).toUpperCase()}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    ...StyleSheet.absoluteFillObject,
  },
  blob: {
    position: "absolute",
    opacity: 0.85,
  },
  image: {
    backgroundColor: colors.pillBackground,
  },
  label: {
    color: "#0A0A0A",
    fontWeight: "700",
    // Sits above the blobs regardless of which corners are filled.
    textShadowColor: "rgba(255,255,255,0.35)",
    textShadowRadius: 6,
  },
});

export { hashSeed };
