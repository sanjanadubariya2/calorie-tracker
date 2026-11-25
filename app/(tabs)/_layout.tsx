import React, { useEffect } from "react";
import { Tabs, router } from "expo-router";
import { TabBar } from "@/components/TabBar";
import { configureForegroundHandling, onPushTapped, refreshRegistration } from "@/lib/pushNotifications";

/** Push is optional: these calls are no-ops when it is off, unsupported or denied. */
function usePushSetup() {
  useEffect(() => {
    configureForegroundHandling();
    refreshRegistration();
    return onPushTapped((target) =>
      router.push(target.params ? { pathname: target.pathname, params: target.params } : target.pathname));
  }, []);
}

export default function TabsLayout() {
  usePushSetup();
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" options={{ title: "Today" }} />
      <Tabs.Screen name="meals" options={{ title: "Meals" }} />
      <Tabs.Screen name="assistant" options={{ title: "Assistant" }} />
      <Tabs.Screen name="friends" options={{ title: "Friends" }} />
      <Tabs.Screen name="reports" options={{ title: "Reports" }} />
      {/* Opened from the avatar in the Today header, not from the bar. */}
      <Tabs.Screen name="profile" options={{ title: "Profile", href: null }} />
    </Tabs>
  );
}
