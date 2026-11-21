import React, { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { getMyAchievements, markAchievementsSeen, pendingCelebrations, type Achievement } from "@/lib/achievements";
import { CelebrationModal } from "./CelebrationModal";

/**
 * Checks for newly unlocked achievements whenever the screen it lives on gains
 * focus (e.g. back on the dashboard after logging a meal) and celebrates each
 * once. Failures are silent: a celebration is never worth an error message.
 */
export function AchievementCelebration({ onCelebrated }: { onCelebrated?: () => void }) {
  const [queue, setQueue] = useState<Achievement[]>([]);
  const showing = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      if (!showing.current) {
        getMyAchievements()
          .then((list) => {
            const pending = pendingCelebrations(list);
            if (live && pending.length && !showing.current) {
              showing.current = true;
              setQueue(pending);
            }
          })
          .catch(() => undefined);
      }
      return () => { live = false; };
    }, [])
  );

  if (!queue.length) return null;
  return (
    <CelebrationModal
      queue={queue}
      onDone={(codes) => {
        setQueue([]);
        showing.current = false;
        markAchievementsSeen(codes).catch(() => undefined).finally(() => onCelebrated?.());
      }}
    />
  );
}
