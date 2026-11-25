import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { colors, fonts, radius, spacing } from "@/constants/theme";

type IconName = React.ComponentProps<typeof Feather>["name"];

/** Tabs shown in the bar, in order. Routes not listed here (profile) stay reachable but hidden. */
const TABS: Record<string, { label: string; icon: IconName }> = {
  index: { label: "Today", icon: "zap" },
  meals: { label: "Meals", icon: "coffee" },
  assistant: { label: "Assistant", icon: "message-circle" },
  friends: { label: "Friends", icon: "users" },
  reports: { label: "Reports", icon: "bar-chart-2" },
};

/** Floating evergreen pill; the active tab expands into a lime chip with its label. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const activeName = state.routes[state.index]?.name;

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, spacing.sm) + spacing.sm }]}>
      <View style={styles.pill}>
        {state.routes.map((route) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const focused = route.name === activeName;
          const onPress = () => {
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={tab.label}
              style={[styles.item, focused && styles.itemActive]}
            >
              <Feather name={tab.icon} size={20} color={focused ? colors.onAccent : colors.heroMuted} />
              {focused && <Text style={styles.label}>{tab.label}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  pill: {
    height: 68,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.sm,
    shadowColor: colors.primary,
    shadowOpacity: 0.28,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  item: {
    height: 52,
    minWidth: 52,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  itemActive: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.md,
  },
  label: {
    fontFamily: fonts.bodyBold,
    fontWeight: "700",
    fontSize: 13,
    color: colors.onAccent,
  },
});
