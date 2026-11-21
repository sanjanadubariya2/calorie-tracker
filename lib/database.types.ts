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
          conversation_id: string | null
          created_at: string
          expires_at: string
          food_log_ids: string[]
          id: string
          kind: string
          origin: string
          payload: Json
          recommendation_item_id: string | null
          status: string
          status_changed_at: string
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          expires_at: string
          food_log_ids?: string[]
          id?: string
          kind?: string
          origin?: string
          payload: Json
          recommendation_item_id?: string | null
          status?: string
          status_changed_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          expires_at?: string
          food_log_ids?: string[]
          id?: string
          kind?: string
          origin?: string
          payload?: Json
          recommendation_item_id?: string | null
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
          {
            foreignKeyName: "assistant_proposals_recommendation_item_id_fkey"
            columns: ["recommendation_item_id"]
            isOneToOne: false
            referencedRelation: "recommendation_items"
            referencedColumns: ["id"]
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
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "food_aliases_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
        ]
      }
      food_attributes: {
        Row: {
          allergen_status: string
          allergens: string[]
          classifier_version: string | null
          countable: boolean | null
          diet_class: string
          diet_status: string
          food_id: string
          jain_compatible: boolean | null
          meal_types: string[]
          reasons: string[]
          regions: string[]
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          updated_at: string
          vegan_compatible: boolean | null
        }
        Insert: {
          allergen_status?: string
          allergens?: string[]
          classifier_version?: string | null
          countable?: boolean | null
          diet_class?: string
          diet_status?: string
          food_id: string
          jain_compatible?: boolean | null
          meal_types?: string[]
          reasons?: string[]
          regions?: string[]
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          updated_at?: string
          vegan_compatible?: boolean | null
        }
        Update: {
          allergen_status?: string
          allergens?: string[]
          classifier_version?: string | null
          countable?: boolean | null
          diet_class?: string
          diet_status?: string
          food_id?: string
          jain_compatible?: boolean | null
          meal_types?: string[]
          reasons?: string[]
          regions?: string[]
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          updated_at?: string
          vegan_compatible?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "food_attributes_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: true
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "food_attributes_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: true
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
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
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
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
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
      meal_template_components: {
        Row: {
          default_servings: number
          food_id: string
          id: string
          max_servings: number
          min_servings: number
          optional: boolean
          position: number
          servings_step: number
          slot: string
          template_id: string
        }
        Insert: {
          default_servings: number
          food_id: string
          id?: string
          max_servings: number
          min_servings: number
          optional?: boolean
          position: number
          servings_step?: number
          slot: string
          template_id: string
        }
        Update: {
          default_servings?: number
          food_id?: string
          id?: string
          max_servings?: number
          min_servings?: number
          optional?: boolean
          position?: number
          servings_step?: number
          slot?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meal_template_components_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "meal_template_components_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meal_template_components_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "meal_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      meal_templates: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          description: string | null
          id: string
          meal_types: string[]
          name: string
          regions: string[]
          slug: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          description?: string | null
          id?: string
          meal_types: string[]
          name: string
          regions?: string[]
          slug: string
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          description?: string | null
          id?: string
          meal_types?: string[]
          name?: string
          regions?: string[]
          slug?: string
          status?: string
          updated_at?: string
          version?: number
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
      recipe_categories: {
        Row: {
          kind: string
          label: string
          slug: string
        }
        Insert: {
          kind: string
          label: string
          slug: string
        }
        Update: {
          kind?: string
          label?: string
          slug?: string
        }
        Relationships: []
      }
      recipe_category_assignments: {
        Row: {
          category_slug: string
          recipe_id: string
        }
        Insert: {
          category_slug: string
          recipe_id: string
        }
        Update: {
          category_slug?: string
          recipe_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_category_assignments_category_slug_fkey"
            columns: ["category_slug"]
            isOneToOne: false
            referencedRelation: "recipe_categories"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "recipe_category_assignments_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipe_ingredients: {
        Row: {
          food_id: string
          grams: number | null
          grams_source: string | null
          id: string
          is_estimate: boolean
          optional: boolean
          position: number
          preparation: string | null
          quantity: number
          recipe_id: string
          unit: string
        }
        Insert: {
          food_id: string
          grams?: number | null
          grams_source?: string | null
          id?: string
          is_estimate?: boolean
          optional?: boolean
          position: number
          preparation?: string | null
          quantity: number
          recipe_id: string
          unit: string
        }
        Update: {
          food_id?: string
          grams?: number | null
          grams_source?: string | null
          id?: string
          is_estimate?: boolean
          optional?: boolean
          position?: number
          preparation?: string | null
          quantity?: number
          recipe_id?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_ingredients_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "recipe_ingredients_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          cook_minutes: number | null
          cooked_weight_g: number | null
          created_at: string
          description: string | null
          equipment: string[] | null
          family_id: string
          id: string
          instructions: string[]
          is_current: boolean
          name: string
          normalized_name: string | null
          nutrition_snapshot: Json | null
          owner_id: string | null
          prep_minutes: number | null
          published_at: string | null
          published_by: string | null
          quantities_estimated: boolean
          serving_label: string
          servings: number
          slug: string
          source: string
          source_name: string | null
          source_ref: string | null
          source_url: string | null
          status: string
          updated_at: string
          variant: string | null
          verification: string
          version: number
        }
        Insert: {
          cook_minutes?: number | null
          cooked_weight_g?: number | null
          created_at?: string
          description?: string | null
          equipment?: string[] | null
          family_id?: string
          id?: string
          instructions?: string[]
          is_current?: boolean
          name: string
          normalized_name?: string | null
          nutrition_snapshot?: Json | null
          owner_id?: string | null
          prep_minutes?: number | null
          published_at?: string | null
          published_by?: string | null
          quantities_estimated?: boolean
          serving_label: string
          servings: number
          slug: string
          source: string
          source_name?: string | null
          source_ref?: string | null
          source_url?: string | null
          status?: string
          updated_at?: string
          variant?: string | null
          verification?: string
          version?: number
        }
        Update: {
          cook_minutes?: number | null
          cooked_weight_g?: number | null
          created_at?: string
          description?: string | null
          equipment?: string[] | null
          family_id?: string
          id?: string
          instructions?: string[]
          is_current?: boolean
          name?: string
          normalized_name?: string | null
          nutrition_snapshot?: Json | null
          owner_id?: string | null
          prep_minutes?: number | null
          published_at?: string | null
          published_by?: string | null
          quantities_estimated?: boolean
          serving_label?: string
          servings?: number
          slug?: string
          source?: string
          source_name?: string | null
          source_ref?: string | null
          source_url?: string | null
          status?: string
          updated_at?: string
          variant?: string | null
          verification?: string
          version?: number
        }
        Relationships: []
      }
      recommendation_events: {
        Row: {
          created_at: string
          event: string
          id: string
          rank: number
          set_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          rank: number
          set_id: string
          user_id?: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          rank?: number
          set_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_events_set_id_rank_fkey"
            columns: ["set_id", "rank"]
            isOneToOne: false
            referencedRelation: "recommendation_items"
            referencedColumns: ["set_id", "rank"]
          },
          {
            foreignKeyName: "recommendation_events_set_id_user_id_fkey"
            columns: ["set_id", "user_id"]
            isOneToOne: false
            referencedRelation: "recommendation_sets"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      recommendation_feedback: {
        Row: {
          created_at: string
          expires_at: string | null
          feedback: string
          food_id: string | null
          id: string
          item_id: string | null
          name: string | null
          recipe_family_id: string | null
          template_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          feedback: string
          food_id?: string | null
          id?: string
          item_id?: string | null
          name?: string | null
          recipe_family_id?: string | null
          template_id?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          feedback?: string
          food_id?: string | null
          id?: string
          item_id?: string | null
          name?: string | null
          recipe_family_id?: string | null
          template_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_feedback_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "recommendation_feedback_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_feedback_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "recommendation_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_feedback_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "meal_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendation_items: {
        Row: {
          created_at: string
          food_id: string | null
          id: string
          kind: string
          outcome: string
          outcome_at: string | null
          rank: number
          recipe_id: string | null
          score: number
          score_breakdown: Json
          set_id: string
          template_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          food_id?: string | null
          id?: string
          kind: string
          outcome?: string
          outcome_at?: string | null
          rank: number
          recipe_id?: string | null
          score: number
          score_breakdown?: Json
          set_id: string
          template_id?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          food_id?: string | null
          id?: string
          kind?: string
          outcome?: string
          outcome_at?: string | null
          rank?: number
          recipe_id?: string | null
          score?: number
          score_breakdown?: Json
          set_id?: string
          template_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_items_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "food_serving_nutrition"
            referencedColumns: ["food_id"]
          },
          {
            foreignKeyName: "recommendation_items_food_id_fkey"
            columns: ["food_id"]
            isOneToOne: false
            referencedRelation: "foods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_items_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_items_set_id_user_id_fkey"
            columns: ["set_id", "user_id"]
            isOneToOne: false
            referencedRelation: "recommendation_sets"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "recommendation_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "meal_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendation_sets: {
        Row: {
          context: Json
          created_at: string
          engine_version: string
          expires_at: string
          id: string
          local_date: string
          meal_type: string
          mode: string
          user_id: string
        }
        Insert: {
          context?: Json
          created_at?: string
          engine_version: string
          expires_at?: string
          id?: string
          local_date: string
          meal_type: string
          mode: string
          user_id?: string
        }
        Update: {
          context?: Json
          created_at?: string
          engine_version?: string
          expires_at?: string
          id?: string
          local_date?: string
          meal_type?: string
          mode?: string
          user_id?: string
        }
        Relationships: []
      }
      user_dietary_preferences: {
        Row: {
          allergies: string[]
          budget: string | null
          created_at: string
          cuisines: string[]
          diet: string | null
          dislikes: string[]
          equipment: string[] | null
          excluded_ingredients: string[]
          max_prep_minutes: number | null
          meal_preferences: string[]
          notes: string | null
          preferred_meal_styles: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          allergies?: string[]
          budget?: string | null
          created_at?: string
          cuisines?: string[]
          diet?: string | null
          dislikes?: string[]
          equipment?: string[] | null
          excluded_ingredients?: string[]
          max_prep_minutes?: number | null
          meal_preferences?: string[]
          notes?: string | null
          preferred_meal_styles?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          allergies?: string[]
          budget?: string | null
          created_at?: string
          cuisines?: string[]
          diet?: string | null
          dislikes?: string[]
          equipment?: string[] | null
          excluded_ingredients?: string[]
          max_prep_minutes?: number | null
          meal_preferences?: string[]
          notes?: string | null
          preferred_meal_styles?: string[]
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
      food_serving_nutrition: {
        Row: {
          calories: number | null
          carbs_g: number | null
          fat_g: number | null
          food_id: string | null
          protein_g: number | null
          quality_flags: string[] | null
          serving_grams: number | null
          serving_label: string | null
        }
        Relationships: []
      }
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
      new_recipe_version: { Args: { p_recipe_id: string }; Returns: string }
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
      publish_recipe: {
        Args: { p_recipe_id: string; p_reviewer: string }
        Returns: Json
      }
      recalculate_user_streak: {
        Args: { p_reset_badges?: boolean; p_user: string }
        Returns: undefined
      }
      recipe_nutrition: {
        Args: { p_recipe_id: string; p_servings?: number }
        Returns: {
          complete: boolean
          missing: string[]
          missing_nutrients: string[]
          per_serving: Json
          recipe_id: string
          scale: number
          servings: number
          total: Json
        }[]
      }
      recipe_nutrition_json: {
        Args: { p_divisor: number; s: Record<string, unknown> }
        Returns: Json
      }
      recipe_portion: {
        Args: { p_portions: number; p_recipe_id: string }
        Returns: Json
      }
      recipe_scaled_ingredients: {
        Args: { p_recipe_id: string; p_servings?: number }
        Returns: {
          food_id: string
          food_name: string
          grams: number
          ingredient_no: number
          optional: boolean
          preparation: string
          quantity: number
          unit: string
        }[]
      }
      recipe_sums: {
        Args: { p_recipe_id: string; p_scale: number }
        Returns: {
          carbs_g: number
          fat_g: number
          fiber_g: number
          grams: number
          ingredient_count: number
          kcal: number
          missing: string[]
          missing_nutrients: string[]
          protein_g: number
          saturated_fat_g: number
          sodium_g: number
          sugars_g: number
        }[]
      }
      recommendation_attributes: {
        Args: { p_food_ids: string[] }
        Returns: {
          allergen_status: string
          allergens: string[]
          diet_classes: string[]
          diet_status: string
          jain_compatible: boolean
          quality_flags: string[]
          vegan_compatible: boolean
        }[]
      }
      recommendation_food_candidates: {
        Args: never
        Returns: {
          allergen_status: string
          allergens: string[]
          calories: number
          carbs_g: number
          category: string
          completeness: number
          countable: boolean
          diet_classes: string[]
          diet_status: string
          fat_g: number
          food_id: string
          food_kind: string
          jain_compatible: boolean
          meal_types: string[]
          name: string
          protein_g: number
          quality_flags: string[]
          regions: string[]
          serving_grams: number
          serving_label: string
          source: string
          vegan_compatible: boolean
          verification: string
        }[]
      }
      recommendation_recipe_candidates: {
        Args: never
        Returns: {
          allergen_status: string
          allergens: string[]
          complete: boolean
          cook_minutes: number
          description: string
          diet_classes: string[]
          diet_status: string
          dish_types: string[]
          equipment: string[]
          family_id: string
          ingredients: Json
          jain_compatible: boolean
          main_food_id: string
          main_food_name: string
          meal_types: string[]
          missing: string[]
          missing_nutrients: string[]
          name: string
          per_serving: Json
          prep_minutes: number
          quality_flags: string[]
          quantities_estimated: boolean
          recipe_id: string
          regions: string[]
          serving_label: string
          servings: number
          slug: string
          source: string
          variant: string
          vegan_compatible: boolean
          verification: string
          version: number
        }[]
      }
      recommendation_template_candidates: {
        Args: never
        Returns: {
          allergen_status: string
          allergens: string[]
          complete: boolean
          components: Json
          description: string
          diet_classes: string[]
          diet_status: string
          jain_compatible: boolean
          main_food_id: string
          main_food_name: string
          meal_types: string[]
          name: string
          quality_flags: string[]
          regions: string[]
          slug: string
          template_id: string
          vegan_compatible: boolean
          version: number
        }[]
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

