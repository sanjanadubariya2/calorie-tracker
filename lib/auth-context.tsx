import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session } from "@supabase/supabase-js";
import { MOCK_MODE, supabase } from "./supabase";
import { mockUserId } from "./mockStore";

export interface SignUpResult {
  /**
   * True when Supabase withheld a session pending email confirmation. Projects
   * with "Confirm email" turned off return a session immediately and never send
   * a mail, so the UI must not promise one unconditionally.
   */
  needsEmailConfirmation: boolean;
}

interface AuthContextValue {
  userId: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const MOCK_SESSION_KEY = "calorie-tracker-mock-session";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (MOCK_MODE) {
      // Mock auth: a signed-in flag in AsyncStorage, no real credentials checked.
      AsyncStorage.getItem(MOCK_SESSION_KEY).then((value) => {
        setUserId(value === "signed-in" ? mockUserId : null);
        setLoading(false);
      });
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user.id ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session: Session | null) => {
      setUserId(session?.user.id ?? null);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      userId,
      loading,
      async signIn(email, password) {
        if (MOCK_MODE) {
          await AsyncStorage.setItem(MOCK_SESSION_KEY, "signed-in");
          setUserId(mockUserId);
          return;
        }
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password) {
        if (MOCK_MODE) {
          await AsyncStorage.setItem(MOCK_SESSION_KEY, "signed-in");
          setUserId(mockUserId);
          return { needsEmailConfirmation: false };
        }
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;

        if (data.session) {
          // Confirmation is off: we're already signed in, so adopt the session
          // rather than waiting on onAuthStateChange.
          setUserId(data.session.user.id);
          return { needsEmailConfirmation: false };
        }
        return { needsEmailConfirmation: true };
      },
      async signOut() {
        if (MOCK_MODE) {
          await AsyncStorage.removeItem(MOCK_SESSION_KEY);
          setUserId(null);
          return;
        }
        await supabase.auth.signOut();
      },
    }),
    [userId, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
