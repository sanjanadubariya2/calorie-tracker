import React, { useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { colors, radius, spacing, typography } from "@/constants/theme";

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

const THUMB_SIZE = 18;

/**
 * Portion multiplier slider. Hand-rolled on PanResponder rather than pulling in
 * @react-native-community/slider — that package isn't in this project and this
 * needs to work on React Native Web too.
 */
export function PortionSlider({ value, onChange, min = 0.25, max = 3, step = 0.25 }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  // PanResponder closes over its callbacks once, so live values go through refs.
  const widthRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const clampToStep = (raw: number) => {
    const stepped = Math.round(raw / step) * step;
    const bounded = Math.min(max, Math.max(min, stepped));
    // Kill floating-point drift from the division above (0.30000000000000004).
    return Math.round(bounded * 100) / 100;
  };

  const valueFromX = (x: number) => {
    const width = widthRef.current;
    if (width <= 0) return min;
    const ratio = Math.min(1, Math.max(0, x / width));
    return clampToStep(min + ratio * (max - min));
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => onChangeRef.current(valueFromX(evt.nativeEvent.locationX)),
        onPanResponderMove: (evt) => onChangeRef.current(valueFromX(evt.nativeEvent.locationX)),
      }),
    // Bounds are fixed for the lifetime of the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function handleLayout(e: LayoutChangeEvent) {
    const width = e.nativeEvent.layout.width;
    widthRef.current = width;
    setTrackWidth(width);
  }

  const ratio = (value - min) / (max - min);
  const thumbLeft = Math.max(0, Math.min(trackWidth, ratio * trackWidth));

  // A tick every 4 steps keeps the dots readable across the default range.
  const tickCount = Math.floor((max - min) / step) + 1;
  const ticks = Array.from({ length: tickCount }, (_, i) => i);

  return (
    <View style={styles.wrap}>
      <View style={[styles.bubble, { left: thumbLeft }]} pointerEvents="none">
        <Text style={styles.bubbleText}>{value % 1 === 0 ? value : value.toFixed(2)}</Text>
      </View>

      <View style={styles.trackArea} onLayout={handleLayout} {...panResponder.panHandlers}>
        <View style={styles.track} />
        <View style={styles.ticksRow} pointerEvents="none">
          {ticks.map((i) => (
            <View key={i} style={styles.tick} />
          ))}
        </View>
        <View style={[styles.thumb, { left: thumbLeft - THUMB_SIZE / 2 }]} pointerEvents="none" />
      </View>

      <View style={styles.scaleRow}>
        <Text style={styles.scaleText}>{min}</Text>
        <Text style={styles.scaleText}>{((min + max) / 2).toFixed(1)}</Text>
        <Text style={styles.scaleText}>{max}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.xl,
  },
  bubble: {
    position: "absolute",
    top: -34,
    marginLeft: -22,
    width: 44,
    alignItems: "center",
    backgroundColor: colors.pillBackground,
    borderRadius: radius.sm,
    paddingVertical: 2,
  },
  bubbleText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  trackArea: {
    height: 32,
    justifyContent: "center",
  },
  track: {
    height: 2,
    backgroundColor: colors.progressTrack,
    borderRadius: radius.pill,
  },
  ticksRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tick: {
    width: 3,
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.textTertiary,
  },
  thumb: {
    position: "absolute",
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.pill,
    backgroundColor: colors.textPrimary,
  },
  scaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  scaleText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
