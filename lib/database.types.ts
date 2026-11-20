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
      assistant_conversations: {
        Row: {
          created_at: string
          estimated_cost_usd: number
          expires_at: string
          id: string
          input_tokens: number
          last_seq: number
          message_count: number
          output_tokens: number
          summary: Json | null
          summary_through_seq: number
          summary_updated_at: string | null
          title: string | null
          turn_started_at: string | null
          turn_status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          estimated_cost_usd?: number
          expires_at?: string
          id?: string
          input_tokens?: number
          last_seq?: number
          message_count?: number
          output_tokens?: number
          summary?: Json | null
          summary_through_seq?: number
          summary_updated_at?: string | null
          title?: string | null
          turn_started_at?: string | null
          turn_status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          estimated_cost_usd?: number
          expires_at?: string
          id?: string
          input_tokens?: number
          last_seq?: number
          message_count?: number
          output_tokens?: number
          summary?: Json | null
          summary_through_seq?: number
          summary_updated_at?: string | null
          title?: string | null
          turn_started_at?: string | null
          turn_status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      assistant_messages: {
        Row: {
          client_message_id: string | null
          content: string
          conversation_id: string
          correlation_id: string | null
          created_at: string
          estimated_cost_usd: number | null
          id: string
          input_tokens: number | null
          model: string | null
          outcome: string | null
          output_tokens: number | null
          response: Json | null
          role: string
          seq: number
          thinking_tokens: number | null
          user_id: string
        }
        Insert: {
          client_message_id?: string | null
          content: string
          conversation_id: string
          correlation_id?: string | null
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          outcome?: string | null
          output_tokens?: number | null
          response?: Json | null
          role: string
          seq: number
          thinking_tokens?: number | null
          user_id: string
        }
        Update: {
          client_message_id?: string | null
          content?: string
          conversation_id?: string
          correlation_id?: string | null
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          outcome?: string | null
          output_tokens?: number | null
          response?: Json | null
          role?: string
          seq?: number
          thinking_tokens?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_messages_conversation_id_user_id_fkey"
            columns: ["conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assistant_conversations"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      assistant_proposals: {
        Row: {
          conversation_id: string
          created_at: string
          expires_at: string
          food_log_ids: string[]
          id: string
          kind: string
          payload: Json
          status: string
          status_changed_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          expires_at: string
          food_log_ids?: string[]
          id?: string
          kind?: string
          payload: Json
          status?: string
          status_changed_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          expires_at?: string
          food_log_ids?: string[]
          id?: string
          kind?: string
          payload?: Json
          status?: string
          status_changed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_proposals_conversation_id_user_id_fkey"
            columns: ["conversation_id", "user_id"]
            isOneToOne: false
            referencedRelation: "assistant_conversations"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      assistant_tool_calls: {
        Row: {
          arguments: Json
          created_at: string
          duration_ms: number | null
          id: string
          message_id: string
          result_chars: number | null
          status: string
          step: number
          tool: string
          user_id: string
        }
        Insert: {
          arguments: Json
          created_at?: string
          duration_ms?: number | null
          id?: string
          message_id: string
          result_chars?: number | null
          status: string
          step: number
          tool: string
          user_id: string
        }
        Update: {
          arguments?: Json
          created_at?: string
          duration_ms?: number | null
          id?: string
          message_id?: string
          result_chars?: number | null
          status?: string
          step?: number
          tool?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_tool_calls_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "assistant_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      assistant_usage_daily: {
        Row: {
          estimated_cost_usd: number
          input_tokens: number
          output_tokens: number
          turns: number
          usage_date: string
          user_id: string
        }
        Insert: {
          estimated_cost_usd?: number
          input_tokens?: number
          output_tokens?: number
          turns?: number
          usage_date: string
          user_id: string
        }
        Update: {
          estimated_cost_usd?: number
          input_tokens?: number
          output_tokens?: number
          turns?: number
          usage_date?: string
          user_id?: string
        }
        Relationships: []
      }
      food_aliases: {
        Row: {
          alias: string
          created_at: string
          food_id: string
          id: string
          kind: string
          normalized_alias: string | null
          source: string
        }
        Insert: {
          alias: string
          created_at?: string
          food_id: string
          id?: string
          kind?: string
          normalized_alias?: string | null
          source?: string
        }
        Update: {
          alias?: string
          created_at?: string
          food_id?: string
          id?: string
          kind?: string
          normalized_alias?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "food_aliases_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
        ]
      }
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
        Relationships: [
          {
            foreignKeyName: "food_logs_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
        ]
      }
      food_servings: {
        Row: {
          created_at: string
          food_id: string
          grams: number
          id: string
          is_default: boolean
          label: string
          ml: number | null
          source: string
        }
        Insert: {
          created_at?: string
          food_id: string
          grams: number
          id?: string
          is_default?: boolean
          label: string
          ml?: number | null
          source?: string
        }
        Update: {
          created_at?: string
          food_id?: string
          grams?: number
          id?: string
          is_default?: boolean
          label?: string
          ml?: number | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "food_servings_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
        ]
      }
      foods: {
        Row: {
          basis: string
          brand: string | null
          carbs_g_per_100: number | null
          category: string | null
          completeness: number
          created_at: string
          cuisine_tags: string[]
          density_g_per_ml: number | null
          fat_g_per_100: number | null
          fiber_g_per_100: number | null
          food_kind: string
          id: string
          is_active: boolean
          is_matchable: boolean | null
          kcal_per_100: number | null
          micronutrients: Json | null
          name: string
          normalized_brand: string | null
          normalized_name: string | null
          protein_g_per_100: number | null
          quality_flags: string[]
          salt_g_per_100: number | null
          saturated_fat_g_per_100: number | null
          search_tsv: unknown
          sodium_g_per_100: number | null
          source: string
          source_ref: string | null
          source_retrieved_at: string | null
          source_version: string | null
          sugars_g_per_100: number | null
          updated_at: string
          variant_group: string | null
          verification: string
        }
        Insert: {
          basis?: string
          brand?: string | null
          carbs_g_per_100?: number | null
          category?: string | null
          completeness?: number
          created_at?: string
          cuisine_tags?: string[]
          density_g_per_ml?: number | null
          fat_g_per_100?: number | null
          fiber_g_per_100?: number | null
          food_kind?: string
          id?: string
          is_active?: boolean
          is_matchable?: boolean | null
          kcal_per_100?: number | null
          micronutrients?: Json | null
          name: string
          normalized_brand?: string | null
          normalized_name?: string | null
          protein_g_per_100?: number | null
          quality_flags?: string[]
          salt_g_per_100?: number | null
          saturated_fat_g_per_100?: number | null
          search_tsv?: unknown
          sodium_g_per_100?: number | null
          source: string
          source_ref?: string | null
          source_retrieved_at?: string | null
          source_version?: string | null
          sugars_g_per_100?: number | null
          updated_at?: string
          variant_group?: string | null
          verification?: string
        }
        Update: {
          basis?: string
          brand?: string | null
          carbs_g_per_100?: number | null
          category?: string | null
          completeness?: number
          created_at?: string
          cuisine_tags?: string[]
          density_g_per_ml?: number | null
          fat_g_per_100?: number | null
          fiber_g_per_100?: number | null
          food_kind?: string
          id?: string
          is_active?: boolean
          is_matchable?: boolean | null
          kcal_per_100?: number | null
          micronutrients?: Json | null
          name?: string
          normalized_brand?: string | null
          normalized_name?: string | null
          protein_g_per_100?: number | null
          quality_flags?: string[]
          salt_g_per_100?: number | null
          saturated_fat_g_per_100?: number | null
          search_tsv?: unknown
          sodium_g_per_100?: number | null
          source?: string
          source_ref?: string | null
          source_retrieved_at?: string | null
          source_version?: string | null
          sugars_g_per_100?: number | null
          updated_at?: string
          variant_group?: string | null
          verification?: string
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
      meal_images: {
        Row: {
          created_at: string
          expires_at: string
          height: number
          id: string
          mime_type: string
          sha256: string
          size_bytes: number
          status: string
          storage_path: string
          user_id: string
          width: number
        }
        Insert: {
          created_at?: string
          expires_at?: string
          height: number
          id?: string
          mime_type?: string
          sha256: string
          size_bytes: number
          status?: string
          storage_path: string
          user_id?: string
          width: number
        }
        Update: {
          created_at?: string
          expires_at?: string
          height?: number
          id?: string
          mime_type?: string
          sha256?: string
          size_bytes?: number
          status?: string
          storage_path?: string
          user_id?: string
          width?: number
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
      user_dietary_preferences: {
        Row: {
          allergies: string[]
          created_at: string
          cuisines: string[]
          diet: string | null
          dislikes: string[]
          meal_preferences: string[]
          notes: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          allergies?: string[]
          created_at?: string
          cuisines?: string[]
          diet?: string | null
          dislikes?: string[]
          meal_preferences?: string[]
          notes?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          allergies?: string[]
          created_at?: string
          cuisines?: string[]
          diet?: string | null
          dislikes?: string[]
          meal_preferences?: string[]
          notes?: string | null
          updated_at?: string
          user_id?: string
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
      food_portion: {
        Args: { p_food_id: string; p_grams: number }
        Returns: {
          calories: number
          carbs_g: number
          fat_g: number
          food_id: string
          nutrients_per_100g: Json
          protein_g: number
        }[]
      }
      food_snapshot_per_100g: {
        Args: { f: Database["public"]["Tables"]["foods"]["Row"] }
        Returns: Json
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
      is_valid_micronutrients: { Args: { p: Json }; Returns: boolean }
      is_valid_nutrients_per_100g: { Args: { p: Json }; Returns: boolean }
      is_valid_text_list: {
        Args: { p_items: string[]; p_max_items: number; p_max_len: number }
        Returns: boolean
      }
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
      normalize_brand: { Args: { p: string }; Returns: string }
      normalize_food_name: { Args: { p: string }; Returns: string }
      portion_nutrition: {
        Args: {
          p_carbs_g_per_100g: number
          p_fat_g_per_100g: number
          p_grams: number
          p_kcal_per_100g: number
          p_protein_g_per_100g: number
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
      search_food_catalogue: {
        Args: {
          p_brand?: string
          p_limit?: number
          p_quantity?: number
          p_query: string
          p_unit?: string
        }
        Returns: {
          basis: string
          brand: string
          carbs_g_per_100: number
          category: string
          completeness: number
          default_serving_g: number
          default_serving_label: string
          density_g_per_ml: number
          fat_g_per_100: number
          fiber_g_per_100: number
          food_id: string
          food_kind: string
          kcal_per_100: number
          match_type: string
          matched_text: string
          name: string
          name_score: number
          portion_carbs_g: number
          portion_fat_g: number
          portion_grams: number
          portion_kcal: number
          portion_protein_g: number
          protein_g_per_100: number
          quality_flags: string[]
          saturated_fat_g_per_100: number
          score: number
          sodium_g_per_100: number
          source: string
          source_ref: string
          sugars_g_per_100: number
          verification: string
        }[]
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

