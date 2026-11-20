export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      food_logs: {
        Row: {
          ai_confidence: number | null
          calories: number
          carbs_g: number
          created_at: string
          fat_g: number
          food_id: string | null
          food_name: string
          id: string
          is_quick_add: boolean
          logged_date: string
          meal_type: string
          nutrients_per_100g: Json | null
          protein_g: number
          serving_g: number | null
          source: string
          source_ref: string | null
          user_id: string
        }
        Insert: {
          ai_confidence?: number | null
          calories: number
          carbs_g?: number
          created_at?: string
          fat_g?: number
          food_id?: string | null
          food_name: string
          id?: string
          is_quick_add?: boolean
          logged_date?: string
          meal_type: string
          nutrients_per_100g?: Json | null
          protein_g?: number
          serving_g?: number | null
          source?: string
          source_ref?: string | null
          user_id: string
        }
        Update: {
          ai_confidence?: number | null
          calories?: number
          carbs_g?: number
          created_at?: string
          fat_g?: number
          food_id?: string | null
          food_name?: string
          id?: string
          is_quick_add?: boolean
          logged_date?: string
          meal_type?: string
          nutrients_per_100g?: Json | null
          protein_g?: number
          serving_g?: number | null
          source?: string
          source_ref?: string | null
          user_id?: string
        }
        Relationships: []
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          id: string
          requester_id: string
          status: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: string
          requester_id: string
          status?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: string
          requester_id?: string
          status?: string
        }
        Relationships: []
      }
      nutrition_target_history: {
        Row: {
          activity_level: string
          created_at: string
          daily_target_kcal: number
          effective_from: string
          formula_version: number
          goal: string
          id: string
          macro_carb_pct: number
          macro_fat_pct: number
          macro_protein_pct: number
          user_id: string
        }
        Insert: {
          activity_level: string
          created_at?: string
          daily_target_kcal: number
          effective_from: string
          formula_version?: number
          goal: string
          id?: string
          macro_carb_pct: number
          macro_fat_pct: number
          macro_protein_pct: number
          user_id: string
        }
        Update: {
          activity_level?: string
          created_at?: string
          daily_target_kcal?: number
          effective_from?: string
          formula_version?: number
          goal?: string
          id?: string
          macro_carb_pct?: number
          macro_fat_pct?: number
          macro_protein_pct?: number
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          activity_level: string
          age: number
          avatar_url: string | null
          created_at: string
          daily_target_kcal: number
          gender: string
          goal: string
          height_cm: number
          id: string
          macro_carb_pct: number
          macro_fat_pct: number
          macro_protein_pct: number
          timezone: string | null
          user_id: string
          username: string | null
          weight_kg: number
        }
        Insert: {
          activity_level?: string
          age: number
          avatar_url?: string | null
          created_at?: string
          daily_target_kcal?: number
          gender: string
          goal: string
          height_cm: number
          id?: string
          macro_carb_pct?: number
          macro_fat_pct?: number
          macro_protein_pct?: number
          timezone?: string | null
          user_id: string
          username?: string | null
          weight_kg: number
        }
        Update: {
          activity_level?: string
          age?: number
          avatar_url?: string | null
          created_at?: string
          daily_target_kcal?: number
          gender?: string
          goal?: string
          height_cm?: number
          id?: string
          macro_carb_pct?: number
          macro_fat_pct?: number
          macro_protein_pct?: number
          timezone?: string | null
          user_id?: string
          username?: string | null
          weight_kg?: number
        }
        Relationships: []
      }
      user_streaks: {
        Row: {
          badges_earned: number
          current_streak: number
          id: string
          last_logged_date: string | null
          longest_streak: number
          user_id: string
        }
        Insert: {
          badges_earned?: number
          current_streak?: number
          id?: string
          last_logged_date?: string | null
          longest_streak?: number
          user_id: string
        }
        Update: {
          badges_earned?: number
          current_streak?: number
          id?: string
          last_logged_date?: string | null
          longest_streak?: number
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activity_factor: { Args: { p_level: string }; Returns: number }
      cancel_friend_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      compute_daily_target: {
        Args: {
          p_activity_level: string
          p_age: number
          p_gender: string
          p_goal: string
          p_height_cm: number
          p_weight_kg: number
        }
        Returns: number
      }
      effective_current_streak: {
        Args: { p_last: string; p_run: number; p_today: string }
        Returns: number
      }
      find_profile_by_username: {
        Args: { p_username: string }
        Returns: {
          avatar_url: string
          user_id: string
          username: string
        }[]
      }
      get_daily_status: {
        Args: { p_date?: string }
        Returns: {
          consumed_carbs_g: number
          consumed_fat_g: number
          consumed_kcal: number
          consumed_protein_g: number
          entry_count: number
          macro_carb_pct: number
          macro_fat_pct: number
          macro_protein_pct: number
          remaining_carbs_g: number
          remaining_fat_g: number
          remaining_kcal: number
          remaining_protein_g: number
          status_date: string
          target_carbs_g: number
          target_fat_g: number
          target_kcal: number
          target_protein_g: number
        }[]
      }
      get_daily_totals: {
        Args: { p_end: string; p_start: string }
        Returns: {
          calories: number
          carbs_g: number
          entry_count: number
          fat_g: number
          logged_date: string
          meal_type: string
          protein_g: number
        }[]
      }
      get_friend_summaries: {
        Args: { p_today: string }
        Returns: {
          avatar_url: string
          avg7_kcal: number
          current_streak: number
          daily_target_kcal: number
          today_kcal: number
          user_id: string
          username: string
        }[]
      }
      get_my_streak: {
        Args: never
        Returns: {
          badges_earned: number
          current_streak: number
          id: string
          last_logged_date: string
          longest_streak: number
          user_id: string
        }[]
      }
      get_outgoing_requests: {
        Args: never
        Returns: {
          avatar_url: string
          friendship_id: string
          user_id: string
          username: string
        }[]
      }
      get_pending_requests: {
        Args: never
        Returns: {
          avatar_url: string
          friendship_id: string
          user_id: string
          username: string
        }[]
      }
      is_valid_nutrients_per_100g: { Args: { p: Json }; Returns: boolean }
      is_valid_timezone: { Args: { p_tz: string }; Returns: boolean }
      macro_targets: {
        Args: {
          p_carb_pct: number
          p_fat_pct: number
          p_protein_pct: number
          p_target_kcal: number
        }
        Returns: Record<string, unknown>
      }
      recalculate_user_streak: {
        Args: { p_reset_badges?: boolean; p_user: string }
        Returns: undefined
      }
      respond_to_friend_request: {
        Args: { p_accept: boolean; p_request_id: string }
        Returns: undefined
      }
      streak_milestone_count: { Args: { p_days: number }; Returns: number }
      user_today_bounds: {
        Args: { p_user: string }
        Returns: Record<string, unknown>
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

