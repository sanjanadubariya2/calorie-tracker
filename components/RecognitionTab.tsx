import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { MEAL_SLOTS, colors, radius, spacing, typography, type MealType } from "@/constants/theme";
import type { NewFoodLog } from "@/lib/types";
import {
  MAX_DESCRIPTION_CHARS,
  RecognitionError,
  groundItems,
  recognitionAvailable,
  recognizePhoto,
  recognizeText,
  type PhotoProgress,
  type RecognitionResponse,
  type RecognitionUnit,
} from "@/lib/recognition";
import {
  canConfirm,
  hasLowConfidence,
  itemsFromRecognition,
  newManualItem,
  reviewReducer,
  reviewTotals,
  saveReviewItems,
  type ReviewAction,
  type ReviewItem,
  type ReviewState,
} from "@/lib/recognitionReview";
import { PhotoPermissionError, pickMealPhoto, takeMealPhoto, type PickedPhoto } from "@/lib/mealPhotoPicker";
import { RecognitionItemCard } from "./RecognitionItemCard";
import { backendOffReason } from "@/lib/backend";

type Phase =
  | { kind: "input" }
  | { kind: "working"; progress: PhotoProgress | null }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "empty"; message: string }
  | { kind: "review" };

type Request = { kind: "text"; text: string } | { kind: "photo"; photo: PickedPhoto };

interface Props {
  initialMeal: MealType;
  loggedDate: string;
  /** Saves one log (lib/api.ts addFoodLog for the signed-in user). */
  addLog: (log: NewFoodLog) => Promise<{ id: string }>;
  /** Everything was saved. */
  onDone: () => void;
  /** Switch to the existing manual logging (Search tab). */
  onManual: () => void;
}

export function RecognitionTab({ initialMeal, loggedDate, addLog, onDone, onManual }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "input" });
  const [text, setText] = useState("");
  const [state, setState] = useState<ReviewState>({ items: [], mealType: initialMeal });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualGrams, setManualGrams] = useState("");

  const stateRef = useRef(state);
  const lastRequest = useRef<Request | null>(null);
  const busy = useRef(false); // synchronous guard: blocks double taps before React re-renders
  const groundSeq = useRef(new Map<string, number>());

  function apply(action: ReviewAction): ReviewState {
    const next = reviewReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    return next;
  }

  /* ---------------------------------------------------------------- recognition */

  async function run(request: Request) {
    if (busy.current) return;
    busy.current = true;
    lastRequest.current = request;
    setSaveError(null);
    setPhase({ kind: "working", progress: request.kind === "photo" ? { stage: "uploading", fraction: null } : null });
    try {
      const response: RecognitionResponse =
        request.kind === "text"
          ? await recognizeText(request.text)
          : await recognizePhoto(request.photo.uri, request.photo.mimeType, (progress) =>
              setPhase({ kind: "working", progress })
            );
      const { recognition, proposal } = response;
      if (recognition.candidates.length === 0) {
        setPhase({
          kind: "empty",
          message:
            recognition.status === "no_food_detected"
              ? "No food was found. Try another photo, or describe what you ate."
              : "That wasn't clear enough to recognise. Try a sharper, well-lit photo or a description.",
        });
        return;
      }
      apply({ type: "reset", items: itemsFromRecognition(recognition.candidates, proposal), mealType: stateRef.current.mealType });
      setPhase({ kind: "review" });
    } catch (error) {
      const e = error instanceof RecognitionError ? error : new RecognitionError("Something went wrong. Please try again.", true);
      setPhase({ kind: "error", message: e.message, retryable: e.retryable });
    } finally {
      busy.current = false;
    }
  }

  async function choosePhoto(source: "camera" | "library") {
    if (busy.current) return;
    try {
      const photo = source === "camera" ? await takeMealPhoto() : await pickMealPhoto();
      if (photo) await run({ kind: "photo", photo });
    } catch (error) {
      const message = error instanceof PhotoPermissionError ? error.message : "Couldn't open the camera or photos.";
      setPhase({ kind: "error", message, retryable: false });
    }
  }

  function retry() {
    if (lastRequest.current) void run(lastRequest.current);
  }

  function startOver() {
    if (busy.current) return;
    apply({ type: "reset", items: [], mealType: stateRef.current.mealType });
    setSaveError(null);
    setPhase({ kind: "input" });
  }

  /* ---------------------------------------------------------------- editing */

  async function reground(item: ReviewItem | undefined) {
    if (!item) return;
    const seq = (groundSeq.current.get(item.key) ?? 0) + 1;
    groundSeq.current.set(item.key, seq);
    apply({ type: "groundStart", key: item.key });
    try {
      const proposal = await groundItems([item.input]);
      if (groundSeq.current.get(item.key) !== seq) return; // a newer edit superseded this one
      apply({ type: "grounded", key: item.key, item: proposal.items[0] });
    } catch (error) {
      if (groundSeq.current.get(item.key) !== seq) return;
      apply({ type: "groundFailed", key: item.key, message: error instanceof Error ? error.message : "Couldn't update this item." });
    }
  }

  function edit(action: ReviewAction & { key: string }) {
    const next = apply(action);
    void reground(next.items.find((it) => it.key === action.key));
  }

  function addManual() {
    const name = manualName.trim();
    if (!name) return;
    const grams = Number(manualGrams.replace(",", "."));
    const item = newManualItem(name, Number.isFinite(grams) && grams > 0 ? grams : null, grams > 0 ? "g" : null);
    apply({ type: "add", item });
    setManualName("");
    setManualGrams("");
    void reground(item);
  }

  /* ---------------------------------------------------------------- saving */

  async function confirm() {
    if (busy.current || saving || !canConfirm(stateRef.current)) return;
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const outcome = await saveReviewItems(stateRef.current, loggedDate, addLog);
      for (const s of outcome.saved) apply({ type: "saved", key: s.key, logId: s.logId });
      if (outcome.failed.length === 0) {
        onDone();
        return;
      }
      setSaveError(
        outcome.saved.length
          ? `Saved ${outcome.saved.length} of ${outcome.saved.length + outcome.failed.length} items. Retry to save the rest.`
          : "Couldn't save. Check your connection and try again."
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  /* ---------------------------------------------------------------- render */

  if (!recognitionAvailable()) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>AI recognition isn't available. {backendOffReason()}</Text>
        <Pressable style={styles.secondaryButton} onPress={onManual} testID="manual-fallback">
          <Text style={styles.secondaryButtonText}>Log manually</Text>
        </Pressable>
      </View>
    );
  }

  if (phase.kind === "working") {
    const p = phase.progress;
    const label =
      p?.stage === "uploading"
        ? `Uploading photo${p.fraction !== null ? ` ${Math.round(p.fraction * 100)}%` : "…"}`
        : "Recognising foods and matching nutrition…";
    return (
      <View style={styles.centered} testID="recognition-working">
        <ActivityIndicator color={colors.link} size="large" />
        <Text style={styles.body}>{label}</Text>
        {p?.stage === "uploading" && p.fraction !== null && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(p.fraction * 100)}%` }]} />
          </View>
        )}
      </View>
    );
  }

  if (phase.kind === "error" || phase.kind === "empty") {
    return (
      <View style={styles.centered} testID={`recognition-${phase.kind}`}>
        <Text style={[styles.body, phase.kind === "error" && styles.errorText]}>{phase.message}</Text>
        {phase.kind === "error" && phase.retryable && (
          <Pressable style={styles.primaryButton} onPress={retry} testID="recognition-retry">
            <Text style={styles.primaryButtonText}>Try again</Text>
          </Pressable>
        )}
        <Pressable style={styles.secondaryButton} onPress={startOver} testID="recognition-start-over">
          <Text style={styles.secondaryButtonText}>Use another photo or description</Text>
        </Pressable>
        <Pressable onPress={onManual} testID="manual-fallback">
          <Text style={styles.link}>Log manually instead</Text>
        </Pressable>
      </View>
    );
  }

  if (phase.kind === "input") {
    return (
      <ScrollView contentContainerStyle={styles.inputWrap} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>
          Snap or upload a photo of your meal, or describe it. You'll review every item before anything is logged.
        </Text>
        <View style={styles.photoRow}>
          <Pressable style={styles.photoButton} onPress={() => choosePhoto("camera")} testID="take-photo">
            <Feather name="camera" size={24} color={colors.onAccent} />
            <Text style={styles.photoText}>Take photo</Text>
          </Pressable>
          <Pressable style={styles.photoButton} onPress={() => choosePhoto("library")} testID="upload-photo">
            <Feather name="image" size={24} color={colors.onAccent} />
            <Text style={styles.photoText}>Upload photo</Text>
          </Pressable>
        </View>
        <Text style={styles.inputLabel}>Or describe it</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={text}
          onChangeText={setText}
          placeholder="e.g. two rotis, one bowl of dal and 150 g paneer sabzi"
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={MAX_DESCRIPTION_CHARS}
          testID="describe-input"
        />
        <Pressable
          style={[styles.primaryButton, !text.trim() && styles.buttonDisabled]}
          disabled={!text.trim()}
          onPress={() => run({ kind: "text", text })}
          testID="describe-submit"
        >
          <Text style={styles.primaryButtonText}>Recognise</Text>
        </Pressable>
        <Text style={styles.privacy}>
          Photos and descriptions are sent to our AI provider for recognition only. Location and camera details are
          removed from photos first.
        </Text>
      </ScrollView>
    );
  }

  // Review
  const totals = reviewTotals(state.items);
  const ready = canConfirm(state);
  const unsaved = state.items.filter((it) => it.savedLogId === null).length;

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.reviewWrap} keyboardShouldPersistTaps="handled" testID="review-list">
        <Text style={styles.inputLabel}>Meal</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mealRow}>
          {MEAL_SLOTS.map((slot) => (
            <Pressable
              key={slot.key}
              style={[styles.chip, state.mealType === slot.key && styles.chipActive]}
              disabled={saving}
              onPress={() => apply({ type: "setMeal", mealType: slot.key })}
              testID={`meal-${slot.key}`}
            >
              <Text style={[styles.chipText, state.mealType === slot.key && styles.chipTextActive]}>{slot.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {hasLowConfidence(state.items) && (
          <Text style={styles.banner} testID="low-confidence-banner">
            Some items are uncertain. Check the food and portion before saving.
          </Text>
        )}

        {state.items.length === 0 && <Text style={styles.body}>No items left. Add a food below or start over.</Text>}

        {state.items.map((item) => (
          <RecognitionItemCard
            key={item.key}
            item={item}
            disabled={saving}
            onRename={(foodName) => edit({ type: "rename", key: item.key, foodName })}
            onSelectFood={(foodId) => edit({ type: "selectFood", key: item.key, foodId })}
            onSetPortion={(quantity: number, unit: RecognitionUnit) => edit({ type: "setPortion", key: item.key, quantity, unit })}
            onRemove={() => apply({ type: "remove", key: item.key })}
            onRetry={() => void reground(stateRef.current.items.find((it) => it.key === item.key))}
          />
        ))}

        <Text style={styles.inputLabel}>Add a food</Text>
        <View style={styles.addRow}>
          <TextInput
            style={[styles.input, styles.flex]}
            value={manualName}
            onChangeText={setManualName}
            placeholder="Food name"
            placeholderTextColor={colors.textTertiary}
            maxLength={120}
            editable={!saving}
            testID="manual-name"
          />
          <TextInput
            style={[styles.input, styles.gramsInput]}
            value={manualGrams}
            onChangeText={setManualGrams}
            placeholder="g"
            placeholderTextColor={colors.textTertiary}
            keyboardType="decimal-pad"
            editable={!saving}
            testID="manual-grams"
          />
          <Pressable style={styles.addButton} onPress={addManual} disabled={saving || !manualName.trim()} testID="manual-add">
            <Text style={styles.primaryButtonText}>Add</Text>
          </Pressable>
        </View>

        <Pressable onPress={startOver} disabled={saving} testID="recognition-start-over">
          <Text style={styles.link}>Start over</Text>
        </Pressable>
      </ScrollView>

      <View style={styles.footer}>
        <Text style={styles.totals} testID="review-totals">
          {totals.isEstimate ? "≈ " : ""}
          {Math.round(totals.calories)} kcal · P {totals.protein_g} g · C {totals.carbs_g} g · F {totals.fat_g} g
        </Text>
        {saveError && <Text style={styles.errorText} testID="save-error">{saveError}</Text>}
        {!ready && unsaved > 0 && !saving && (
          <Text style={styles.caption}>Resolve or remove the highlighted items to save.</Text>
        )}
        <Pressable
          style={[styles.primaryButton, (!ready || saving) && styles.buttonDisabled]}
          disabled={!ready || saving}
          onPress={confirm}
          testID="confirm-save"
        >
          <Text style={styles.primaryButtonText}>
            {saving ? "Saving…" : saveError ? "Retry saving" : `Confirm & log ${unsaved} item${unsaved === 1 ? "" : "s"}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, paddingHorizontal: spacing.md },
  inputWrap: { paddingTop: spacing.md, paddingBottom: spacing.xl },
  reviewWrap: { paddingTop: spacing.sm, paddingBottom: spacing.lg },
  hint: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.lg },
  body: { ...typography.body, color: colors.textPrimary, textAlign: "center" },
  caption: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  privacy: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.lg },
  photoRow: { flexDirection: "row", gap: spacing.md },
  photoButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  photoText: { ...typography.label, color: colors.textPrimary, marginTop: spacing.sm },
  inputLabel: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.xs, marginTop: spacing.lg },
  input: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...typography.body,
  },
  textArea: { minHeight: 96, textAlignVertical: "top" },
  primaryButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    marginTop: spacing.md,
    alignSelf: "stretch",
  },
  primaryButtonText: { ...typography.label, color: colors.onAccent },
  buttonDisabled: { opacity: 0.4 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    alignSelf: "stretch",
  },
  secondaryButtonText: { ...typography.label, color: colors.textPrimary },
  link: { ...typography.label, color: colors.link, textAlign: "center", marginTop: spacing.md },
  errorText: { ...typography.caption, color: colors.danger, textAlign: "center", marginBottom: spacing.sm },
  progressTrack: { height: 6, alignSelf: "stretch", backgroundColor: colors.progressTrack, borderRadius: radius.pill },
  progressFill: { height: 6, backgroundColor: colors.progressFill, borderRadius: radius.pill },
  mealRow: { marginBottom: spacing.md },
  chip: {
    backgroundColor: colors.pillBackground,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: spacing.sm,
  },
  chipActive: { backgroundColor: colors.progressFill },
  chipText: { ...typography.caption, color: colors.textSecondary },
  chipTextActive: { color: colors.onPrimary },
  banner: {
    ...typography.caption,
    color: colors.warning,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  addRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  gramsInput: { width: 70 },
  addButton: {
    backgroundColor: colors.progressFill,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  footer: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: spacing.sm, paddingBottom: spacing.md },
  totals: { ...typography.label, color: colors.textPrimary, textAlign: "center" },
});
