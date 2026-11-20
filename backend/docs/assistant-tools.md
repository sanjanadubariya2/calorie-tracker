# Assistant tools

Generated from the registry (`python -m app.cli assistant-tools-doc`). All tools are read-only, run as the signed-in user (RLS applies) and can't take a user id. Inputs are validated before running; outputs are capped at `ASSISTANT_MAX_TOOL_RESULT_CHARS`.

## `get_daily_status`

Calories, protein, carbs and fat the signed-in user has logged on a day (today by default), with their daily targets and what remains. Use for any question about today's or a specific day's intake or what's left.

Backs response types: nutrition_summary

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "date": {
      "description": "YYYY-MM-DD. Omit for today.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    }
  },
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "NutrientStatus": {
      "properties": {
        "consumed": {
          "title": "Consumed",
          "type": "number"
        },
        "target": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Target"
        },
        "remaining": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Remaining"
        }
      },
      "required": [
        "consumed",
        "target",
        "remaining"
      ],
      "title": "NutrientStatus",
      "type": "object"
    }
  },
  "properties": {
    "date": {
      "format": "date",
      "title": "Date",
      "type": "string"
    },
    "has_targets": {
      "title": "Has Targets",
      "type": "boolean"
    },
    "calories_kcal": {
      "$ref": "#/$defs/NutrientStatus"
    },
    "protein_g": {
      "$ref": "#/$defs/NutrientStatus"
    },
    "carbs_g": {
      "$ref": "#/$defs/NutrientStatus"
    },
    "fat_g": {
      "$ref": "#/$defs/NutrientStatus"
    },
    "entries_logged": {
      "title": "Entries Logged",
      "type": "integer"
    },
    "data_source": {
      "const": "food_log",
      "default": "food_log",
      "title": "Data Source",
      "type": "string"
    }
  },
  "required": [
    "date",
    "has_targets",
    "calories_kcal",
    "protein_g",
    "carbs_g",
    "fat_g",
    "entries_logged"
  ],
  "title": "DailyStatusResult",
  "type": "object"
}
```

## `get_recent_food_logs`

Individual foods the user logged in a date range (at most 31 days, default the last 7 days), newest first, optionally for one meal type. Use only when specific foods matter; for totals and trends use get_nutrition_history.

Backs response types: none (context only)

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "start_date": {
      "description": "YYYY-MM-DD. Default: 7 days before end_date.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    },
    "end_date": {
      "description": "YYYY-MM-DD. Default: today.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    },
    "meal_type": {
      "enum": [
        "breakfast",
        "lunch",
        "dinner",
        "morning_snack",
        "afternoon_snack",
        "evening_snack",
        null
      ],
      "type": [
        "string",
        "null"
      ]
    },
    "limit": {
      "maximum": 50,
      "minimum": 1,
      "type": "integer"
    }
  },
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "LogEntry": {
      "properties": {
        "date": {
          "format": "date",
          "title": "Date",
          "type": "string"
        },
        "meal_type": {
          "title": "Meal Type",
          "type": "string"
        },
        "food_name": {
          "title": "Food Name",
          "type": "string"
        },
        "calories_kcal": {
          "title": "Calories Kcal",
          "type": "number"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "number"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "number"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "number"
        },
        "serving_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Serving G"
        },
        "source": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Source"
        }
      },
      "required": [
        "date",
        "meal_type",
        "food_name",
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "serving_g",
        "source"
      ],
      "title": "LogEntry",
      "type": "object"
    }
  },
  "properties": {
    "start_date": {
      "format": "date",
      "title": "Start Date",
      "type": "string"
    },
    "end_date": {
      "format": "date",
      "title": "End Date",
      "type": "string"
    },
    "meal_type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "title": "Meal Type"
    },
    "entries": {
      "items": {
        "$ref": "#/$defs/LogEntry"
      },
      "title": "Entries",
      "type": "array"
    },
    "returned": {
      "title": "Returned",
      "type": "integer"
    },
    "more_available": {
      "title": "More Available",
      "type": "boolean"
    }
  },
  "required": [
    "start_date",
    "end_date",
    "meal_type",
    "entries",
    "returned",
    "more_available"
  ],
  "title": "RecentLogsResult",
  "type": "object"
}
```

## `search_foods`

Search the food catalogue (Indian Nutrient Databank and verified products) by name. Returns nutrition per 100 g, the default serving, the source and how well each result matches.

Backs response types: food_search_results

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "query": {
      "description": "A food name, e.g. 'paneer butter masala'.",
      "maxLength": 80,
      "minLength": 2,
      "type": "string"
    },
    "brand": {
      "maxLength": 80,
      "type": [
        "string",
        "null"
      ]
    },
    "limit": {
      "maximum": 10,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "FoodResult": {
      "properties": {
        "food_id": {
          "format": "uuid",
          "title": "Food Id",
          "type": "string"
        },
        "name": {
          "title": "Name",
          "type": "string"
        },
        "brand": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Brand"
        },
        "category": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Category"
        },
        "source": {
          "title": "Source",
          "type": "string"
        },
        "source_ref": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Source Ref"
        },
        "per_100": {
          "$ref": "#/$defs/Per100"
        },
        "default_serving": {
          "anyOf": [
            {
              "$ref": "#/$defs/ServingOut"
            },
            {
              "type": "null"
            }
          ]
        },
        "match": {
          "$ref": "#/$defs/MatchInfo"
        },
        "quality_flags": {
          "items": {
            "type": "string"
          },
          "title": "Quality Flags",
          "type": "array"
        }
      },
      "required": [
        "food_id",
        "name",
        "brand",
        "category",
        "source",
        "source_ref",
        "per_100",
        "default_serving",
        "match",
        "quality_flags"
      ],
      "title": "FoodResult",
      "type": "object"
    },
    "MatchInfo": {
      "properties": {
        "confidence": {
          "title": "Confidence",
          "type": "number"
        },
        "match_type": {
          "title": "Match Type",
          "type": "string"
        }
      },
      "required": [
        "confidence",
        "match_type"
      ],
      "title": "MatchInfo",
      "type": "object"
    },
    "Per100": {
      "properties": {
        "basis": {
          "title": "Basis",
          "type": "string"
        },
        "kcal": {
          "title": "Kcal",
          "type": "number"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "number"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "number"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "number"
        },
        "fiber_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Fiber G"
        },
        "sugars_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Sugars G"
        }
      },
      "required": [
        "basis",
        "kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugars_g"
      ],
      "title": "Per100",
      "type": "object"
    },
    "ServingOut": {
      "properties": {
        "label": {
          "title": "Label",
          "type": "string"
        },
        "grams": {
          "title": "Grams",
          "type": "number"
        }
      },
      "required": [
        "label",
        "grams"
      ],
      "title": "ServingOut",
      "type": "object"
    }
  },
  "properties": {
    "query": {
      "title": "Query",
      "type": "string"
    },
    "decision": {
      "title": "Decision",
      "type": "string"
    },
    "results": {
      "items": {
        "$ref": "#/$defs/FoodResult"
      },
      "title": "Results",
      "type": "array"
    }
  },
  "required": [
    "query",
    "decision",
    "results"
  ],
  "title": "SearchFoodsResult",
  "type": "object"
}
```

## `get_user_targets`

The user's configured daily calorie and macro targets, goal, activity level and the dietary preferences they entered themselves (diet, allergies, dislikes, cuisines).

Backs response types: nutrition_summary

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {},
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "PreferencesOut": {
      "properties": {
        "diet": {
          "anyOf": [
            {
              "enum": [
                "omnivore",
                "eggetarian",
                "vegetarian",
                "vegan",
                "pescatarian",
                "jain"
              ],
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Diet"
        },
        "allergies": {
          "items": {
            "type": "string"
          },
          "title": "Allergies",
          "type": "array"
        },
        "dislikes": {
          "items": {
            "type": "string"
          },
          "title": "Dislikes",
          "type": "array"
        },
        "cuisines": {
          "items": {
            "type": "string"
          },
          "title": "Cuisines",
          "type": "array"
        },
        "meal_preferences": {
          "items": {
            "type": "string"
          },
          "title": "Meal Preferences",
          "type": "array"
        },
        "notes": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Notes"
        },
        "updated_at": {
          "anyOf": [
            {
              "format": "date-time",
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Updated At"
        },
        "source": {
          "const": "user_entered",
          "default": "user_entered",
          "title": "Source",
          "type": "string"
        }
      },
      "required": [
        "diet",
        "allergies",
        "dislikes",
        "cuisines",
        "meal_preferences",
        "notes"
      ],
      "title": "PreferencesOut",
      "type": "object"
    },
    "Targets": {
      "properties": {
        "calories_kcal": {
          "title": "Calories Kcal",
          "type": "integer"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "integer"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "integer"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "integer"
        },
        "carb_pct": {
          "title": "Carb Pct",
          "type": "integer"
        },
        "fat_pct": {
          "title": "Fat Pct",
          "type": "integer"
        },
        "protein_pct": {
          "title": "Protein Pct",
          "type": "integer"
        }
      },
      "required": [
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "carb_pct",
        "fat_pct",
        "protein_pct"
      ],
      "title": "Targets",
      "type": "object"
    }
  },
  "properties": {
    "has_targets": {
      "title": "Has Targets",
      "type": "boolean"
    },
    "daily_targets": {
      "anyOf": [
        {
          "$ref": "#/$defs/Targets"
        },
        {
          "type": "null"
        }
      ]
    },
    "goal": {
      "anyOf": [
        {
          "enum": [
            "lose",
            "maintain",
            "gain"
          ],
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "title": "Goal"
    },
    "activity_level": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "title": "Activity Level"
    },
    "preferences": {
      "anyOf": [
        {
          "$ref": "#/$defs/PreferencesOut"
        },
        {
          "type": "null"
        }
      ]
    },
    "notes": {
      "items": {
        "type": "string"
      },
      "title": "Notes",
      "type": "array"
    }
  },
  "required": [
    "has_targets",
    "daily_targets",
    "goal",
    "activity_level",
    "preferences",
    "notes"
  ],
  "title": "UserTargetsResult",
  "type": "object"
}
```

## `get_nutrition_history`

Aggregated calories and macros over a period (at most 90 days, default the last 7 days), per day or per week, with averages, days logged and how many days were near the target. Use for trends and 'how have I been doing' questions.

Backs response types: nutrition_summary

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "start_date": {
      "description": "YYYY-MM-DD. Default: 7 days before end_date.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    },
    "end_date": {
      "description": "YYYY-MM-DD. Default: today.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    },
    "group_by": {
      "enum": [
        "day",
        "week"
      ],
      "type": "string"
    }
  },
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "DayPoint": {
      "properties": {
        "date": {
          "format": "date",
          "title": "Date",
          "type": "string"
        },
        "kcal": {
          "title": "Kcal",
          "type": "number"
        }
      },
      "required": [
        "date",
        "kcal"
      ],
      "title": "DayPoint",
      "type": "object"
    },
    "HistoryOverall": {
      "properties": {
        "days_in_range": {
          "title": "Days In Range",
          "type": "integer"
        },
        "days_logged": {
          "title": "Days Logged",
          "type": "integer"
        },
        "avg_kcal_per_logged_day": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Kcal Per Logged Day"
        },
        "avg_protein_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Protein G"
        },
        "avg_carbs_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Carbs G"
        },
        "avg_fat_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Fat G"
        },
        "current_target_kcal": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "title": "Current Target Kcal"
        },
        "logged_days_within_10pct_of_target": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "title": "Logged Days Within 10Pct Of Target"
        },
        "highest_day": {
          "anyOf": [
            {
              "$ref": "#/$defs/DayPoint"
            },
            {
              "type": "null"
            }
          ]
        },
        "lowest_day": {
          "anyOf": [
            {
              "$ref": "#/$defs/DayPoint"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "days_in_range",
        "days_logged",
        "avg_kcal_per_logged_day",
        "avg_protein_g",
        "avg_carbs_g",
        "avg_fat_g",
        "current_target_kcal",
        "logged_days_within_10pct_of_target",
        "highest_day",
        "lowest_day"
      ],
      "title": "HistoryOverall",
      "type": "object"
    },
    "Period": {
      "properties": {
        "start": {
          "format": "date",
          "title": "Start",
          "type": "string"
        },
        "end": {
          "format": "date",
          "title": "End",
          "type": "string"
        },
        "days": {
          "title": "Days",
          "type": "integer"
        },
        "days_logged": {
          "title": "Days Logged",
          "type": "integer"
        },
        "entries": {
          "title": "Entries",
          "type": "integer"
        },
        "total_kcal": {
          "title": "Total Kcal",
          "type": "number"
        },
        "avg_kcal_per_logged_day": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Kcal Per Logged Day"
        },
        "avg_protein_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Protein G"
        },
        "avg_carbs_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Carbs G"
        },
        "avg_fat_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Avg Fat G"
        }
      },
      "required": [
        "start",
        "end",
        "days",
        "days_logged",
        "entries",
        "total_kcal",
        "avg_kcal_per_logged_day",
        "avg_protein_g",
        "avg_carbs_g",
        "avg_fat_g"
      ],
      "title": "Period",
      "type": "object"
    }
  },
  "properties": {
    "start_date": {
      "format": "date",
      "title": "Start Date",
      "type": "string"
    },
    "end_date": {
      "format": "date",
      "title": "End Date",
      "type": "string"
    },
    "group_by": {
      "enum": [
        "day",
        "week"
      ],
      "title": "Group By",
      "type": "string"
    },
    "periods": {
      "items": {
        "$ref": "#/$defs/Period"
      },
      "title": "Periods",
      "type": "array"
    },
    "overall": {
      "$ref": "#/$defs/HistoryOverall"
    },
    "notes": {
      "items": {
        "type": "string"
      },
      "title": "Notes",
      "type": "array"
    }
  },
  "required": [
    "start_date",
    "end_date",
    "group_by",
    "periods",
    "overall",
    "notes"
  ],
  "title": "HistoryResult",
  "type": "object"
}
```

## `recommend_meals`

Suggest catalogue foods for a meal that fit the user's remaining calories and macros today and their stated diet, allergies and dislikes. Ranking and nutrition are computed by the backend; explain the results, don't change their numbers.

Backs response types: meal_recommendation

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "meal_type": {
      "description": "Which meal to suggest for. Ask the user if unclear.",
      "enum": [
        "breakfast",
        "lunch",
        "dinner",
        "snack"
      ],
      "type": "string"
    },
    "count": {
      "maximum": 5,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "meal_type"
  ],
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "MealTarget": {
      "properties": {
        "calories_kcal": {
          "title": "Calories Kcal",
          "type": "number"
        },
        "protein_g": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Protein G"
        }
      },
      "required": [
        "calories_kcal",
        "protein_g"
      ],
      "title": "MealTarget",
      "type": "object"
    },
    "RecNutrition": {
      "properties": {
        "calories_kcal": {
          "title": "Calories Kcal",
          "type": "number"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "number"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "number"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "number"
        }
      },
      "required": [
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g"
      ],
      "title": "RecNutrition",
      "type": "object"
    },
    "Recommendation": {
      "properties": {
        "food_id": {
          "format": "uuid",
          "title": "Food Id",
          "type": "string"
        },
        "name": {
          "title": "Name",
          "type": "string"
        },
        "category": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Category"
        },
        "serving_label": {
          "title": "Serving Label",
          "type": "string"
        },
        "serving_g": {
          "title": "Serving G",
          "type": "number"
        },
        "nutrition": {
          "$ref": "#/$defs/RecNutrition"
        },
        "source": {
          "title": "Source",
          "type": "string"
        },
        "source_ref": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Source Ref"
        },
        "score": {
          "title": "Score",
          "type": "number"
        },
        "reasons": {
          "items": {
            "type": "string"
          },
          "title": "Reasons",
          "type": "array"
        }
      },
      "required": [
        "food_id",
        "name",
        "category",
        "serving_label",
        "serving_g",
        "nutrition",
        "source",
        "source_ref",
        "score",
        "reasons"
      ],
      "title": "Recommendation",
      "type": "object"
    }
  },
  "properties": {
    "meal_type": {
      "enum": [
        "breakfast",
        "lunch",
        "dinner",
        "snack"
      ],
      "title": "Meal Type",
      "type": "string"
    },
    "meal_target": {
      "$ref": "#/$defs/MealTarget"
    },
    "remaining_today": {
      "anyOf": [
        {
          "$ref": "#/$defs/RecNutrition"
        },
        {
          "type": "null"
        }
      ]
    },
    "recommendations": {
      "items": {
        "$ref": "#/$defs/Recommendation"
      },
      "title": "Recommendations",
      "type": "array"
    },
    "filters_applied": {
      "items": {
        "type": "string"
      },
      "title": "Filters Applied",
      "type": "array"
    },
    "cautions": {
      "items": {
        "type": "string"
      },
      "title": "Cautions",
      "type": "array"
    },
    "notes": {
      "items": {
        "type": "string"
      },
      "title": "Notes",
      "type": "array"
    },
    "data_source": {
      "const": "catalogue",
      "default": "catalogue",
      "title": "Data Source",
      "type": "string"
    }
  },
  "required": [
    "meal_type",
    "meal_target",
    "remaining_today",
    "recommendations",
    "filters_applied",
    "cautions",
    "notes"
  ],
  "title": "RecommendResult",
  "type": "object"
}
```

## `prepare_food_log`

Prepare a food-log PROPOSAL when the user asks to log food. Matches each food in the catalogue, resolves the portion and computes nutrition. Returns either a pending proposal (the user confirms or cancels it in the app) or questions to ask when a food is ambiguous or a quantity is missing. It never saves anything, and nothing you say can confirm it.

Backs response types: proposed_action, clarification

Input (sent to the model as the function's JSON Schema):

```json
{
  "additionalProperties": false,
  "properties": {
    "items": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "food_name": {
            "description": "The food as the user named it.",
            "maxLength": 120,
            "minLength": 1,
            "type": "string"
          },
          "food_id": {
            "description": "Only a food_id returned by search_foods or prepare_food_log options in THIS turn, when the user's choice is clear. Omit to let the catalogue matcher decide.",
            "format": "uuid",
            "type": [
              "string",
              "null"
            ]
          },
          "quantity": {
            "description": "Only what the user said. Omit if not stated.",
            "exclusiveMinimum": 0,
            "maximum": 10000,
            "type": [
              "number",
              "null"
            ]
          },
          "unit": {
            "description": "piece, bowl, katori, g, ml, ... Omit if not stated.",
            "enum": [
              "g",
              "kg",
              "ml",
              "l",
              "piece",
              "bowl",
              "katori",
              "cup",
              "glass",
              "plate",
              "slice",
              "tablespoon",
              "teaspoon",
              "serving",
              null
            ],
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "food_name"
        ],
        "type": "object"
      },
      "maxItems": 10,
      "minItems": 1,
      "type": "array"
    },
    "meal_type": {
      "description": "Ask the user if they didn't say which meal.",
      "enum": [
        "breakfast",
        "lunch",
        "dinner",
        "morning_snack",
        "afternoon_snack",
        "evening_snack"
      ],
      "type": "string"
    },
    "date": {
      "description": "YYYY-MM-DD. Omit for today.",
      "format": "date",
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "items",
    "meal_type"
  ],
  "type": "object"
}
```

Output (`result`):

```json
{
  "$defs": {
    "FoodLogProposal": {
      "properties": {
        "id": {
          "format": "uuid",
          "title": "Id",
          "type": "string"
        },
        "status": {
          "enum": [
            "pending",
            "confirming",
            "confirmed",
            "rejected",
            "expired"
          ],
          "title": "Status",
          "type": "string"
        },
        "expires_at": {
          "format": "date-time",
          "title": "Expires At",
          "type": "string"
        },
        "meal_type": {
          "enum": [
            "breakfast",
            "lunch",
            "dinner",
            "morning_snack",
            "afternoon_snack",
            "evening_snack"
          ],
          "title": "Meal Type",
          "type": "string"
        },
        "logged_date": {
          "format": "date",
          "title": "Logged Date",
          "type": "string"
        },
        "items": {
          "items": {
            "$ref": "#/$defs/ProposedFood"
          },
          "title": "Items",
          "type": "array"
        },
        "totals": {
          "$ref": "#/$defs/ProposalTotals"
        },
        "requires_user_confirmation": {
          "const": true,
          "default": true,
          "title": "Requires User Confirmation",
          "type": "boolean"
        },
        "food_log_ids": {
          "items": {
            "format": "uuid",
            "type": "string"
          },
          "title": "Food Log Ids",
          "type": "array"
        }
      },
      "required": [
        "id",
        "status",
        "expires_at",
        "meal_type",
        "logged_date",
        "items",
        "totals"
      ],
      "title": "FoodLogProposal",
      "type": "object"
    },
    "FoodOptionOut": {
      "properties": {
        "food_id": {
          "format": "uuid",
          "title": "Food Id",
          "type": "string"
        },
        "name": {
          "title": "Name",
          "type": "string"
        },
        "kcal_per_100": {
          "title": "Kcal Per 100",
          "type": "number"
        },
        "default_serving": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Default Serving"
        }
      },
      "required": [
        "food_id",
        "name",
        "kcal_per_100",
        "default_serving"
      ],
      "title": "FoodOptionOut",
      "type": "object"
    },
    "ItemIssue": {
      "properties": {
        "requested_name": {
          "title": "Requested Name",
          "type": "string"
        },
        "issue": {
          "enum": [
            "ambiguous_food",
            "unknown_food",
            "quantity_missing",
            "portion_unresolved",
            "nutrition_unavailable"
          ],
          "title": "Issue",
          "type": "string"
        },
        "question": {
          "title": "Question",
          "type": "string"
        },
        "options": {
          "items": {
            "$ref": "#/$defs/FoodOptionOut"
          },
          "title": "Options",
          "type": "array"
        }
      },
      "required": [
        "requested_name",
        "issue",
        "question"
      ],
      "title": "ItemIssue",
      "type": "object"
    },
    "ItemNutrition": {
      "properties": {
        "calories": {
          "title": "Calories",
          "type": "number"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "number"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "number"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "number"
        }
      },
      "required": [
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g"
      ],
      "title": "ItemNutrition",
      "type": "object"
    },
    "ProposalTotals": {
      "properties": {
        "calories": {
          "title": "Calories",
          "type": "number"
        },
        "protein_g": {
          "title": "Protein G",
          "type": "number"
        },
        "carbs_g": {
          "title": "Carbs G",
          "type": "number"
        },
        "fat_g": {
          "title": "Fat G",
          "type": "number"
        }
      },
      "required": [
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g"
      ],
      "title": "ProposalTotals",
      "type": "object"
    },
    "ProposedFood": {
      "properties": {
        "food_id": {
          "format": "uuid",
          "title": "Food Id",
          "type": "string"
        },
        "food_name": {
          "title": "Food Name",
          "type": "string"
        },
        "requested_name": {
          "title": "Requested Name",
          "type": "string"
        },
        "quantity": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ],
          "title": "Quantity"
        },
        "unit": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Unit"
        },
        "grams": {
          "title": "Grams",
          "type": "number"
        },
        "quantity_source": {
          "title": "Quantity Source",
          "type": "string"
        },
        "portion_source": {
          "title": "Portion Source",
          "type": "string"
        },
        "portion_is_estimate": {
          "title": "Portion Is Estimate",
          "type": "boolean"
        },
        "portion_explanation": {
          "title": "Portion Explanation",
          "type": "string"
        },
        "nutrition": {
          "$ref": "#/$defs/ItemNutrition"
        },
        "per_100g": {
          "additionalProperties": {
            "type": "number"
          },
          "title": "Per 100G",
          "type": "object"
        },
        "nutrition_source": {
          "title": "Nutrition Source",
          "type": "string"
        },
        "source_ref": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "title": "Source Ref"
        },
        "warnings": {
          "items": {
            "type": "string"
          },
          "title": "Warnings",
          "type": "array"
        }
      },
      "required": [
        "food_id",
        "food_name",
        "requested_name",
        "quantity",
        "unit",
        "grams",
        "quantity_source",
        "portion_source",
        "portion_is_estimate",
        "portion_explanation",
        "nutrition",
        "per_100g",
        "nutrition_source",
        "source_ref",
        "warnings"
      ],
      "title": "ProposedFood",
      "type": "object"
    }
  },
  "properties": {
    "status": {
      "enum": [
        "proposed",
        "needs_clarification"
      ],
      "title": "Status",
      "type": "string"
    },
    "proposal": {
      "anyOf": [
        {
          "$ref": "#/$defs/FoodLogProposal"
        },
        {
          "type": "null"
        }
      ],
      "default": null
    },
    "issues": {
      "items": {
        "$ref": "#/$defs/ItemIssue"
      },
      "title": "Issues",
      "type": "array"
    },
    "note": {
      "title": "Note",
      "type": "string"
    }
  },
  "required": [
    "status",
    "note"
  ],
  "title": "PrepareFoodLogResult",
  "type": "object"
}
```

## `respond` (final answer)

Every turn ends with exactly one `respond` call. The server validates it and builds the response; data cards come from this turn's tool results.

```json
{
  "additionalProperties": false,
  "description": "Arguments of the `respond` tool.",
  "properties": {
    "response_type": {
      "description": "text: general answer. nutrition_summary: about the user's own intake/targets/trends (needs data from get_daily_status, get_nutrition_history or get_user_targets this turn). meal_recommendation: needs recommend_meals. food_search_results: needs search_foods. proposed_action: a food-log proposal made by prepare_food_log this turn; the user confirms it in the app. clarification: ask the user a question.",
      "enum": [
        "text",
        "nutrition_summary",
        "meal_recommendation",
        "food_search_results",
        "proposed_action",
        "clarification"
      ],
      "title": "Response Type",
      "type": "string"
    },
    "message": {
      "description": "What the user reads. Plain text.",
      "maxLength": 4000,
      "minLength": 1,
      "title": "Message",
      "type": "string"
    },
    "clarification_options": {
      "description": "Optional short answer choices for a clarification.",
      "items": {
        "type": "string"
      },
      "maxItems": 4,
      "title": "Clarification Options",
      "type": "array"
    }
  },
  "required": [
    "response_type",
    "message"
  ],
  "title": "RespondArgs",
  "type": "object"
}
```
