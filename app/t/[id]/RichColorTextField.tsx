"use client";

import {
  useEffect,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  applyColorToRange,
  getColorForInsertion,
  getPlainTextFromSegments,
  normalizeHexColor,
  normalizeSegments,
  reconcileSegmentsWithPlainTextAndColor,
  replaceTextRangeInSegmentsWithColor,
  type TextSegment
} from "@/lib/richTextSegments";

type SelectionRange = {
  start: number;
  end: number;
};

export type RichColorTextFieldHandle = {
  applyColorToSelection: (color: string) => boolean;
};

type RichColorTextFieldProps = {
  id: string;
  segments: TextSegment[];
  defaultColor: string;
  disabled?: boolean;
  onChangeSegments: (next: TextSegment[]) => void;
};

function ensureEditorSegments(input: unknown, fallbackColor: string, emptyColor: string): TextSegment[] {
  const normalized = normalizeSegments(input, fallbackColor);
  if (getPlainTextFromSegments(normalized).length > 0) {
    return normalized;
  }
  return [{ text: "", color: normalizeHexColor(emptyColor, fallbackColor) }];
}

function getPreferredEmptyColor(segments: TextSegment[], fallbackColor: string): string {
  const first = Array.isArray(segments) ? segments[0] : null;
  return normalizeHexColor(first?.color, fallbackColor);
}

function buildFragmentFromSegments(doc: Document, segments: TextSegment[]): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const segment of segments) {
    const span = doc.createElement("span");
    span.dataset.segmentColor = segment.color;
    span.style.color = segment.color;
    span.textContent = segment.text;
    fragment.appendChild(span);
  }
  return fragment;
}

function domMatchesSegments(root: HTMLElement, segments: TextSegment[]): boolean {
  if (root.childNodes.length !== segments.length) return false;
  for (let index = 0; index < segments.length; index += 1) {
    const node = root.childNodes[index];
    if (!(node instanceof HTMLSpanElement)) return false;
    const expected = segments[index];
    if ((node.textContent ?? "") !== expected.text) return false;
    if ((node.dataset.segmentColor ?? "").toUpperCase() !== expected.color.toUpperCase()) return false;
  }
  return true;
}

function getSelectionRange(root: HTMLElement): SelectionRange | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);

  const start = startRange.toString().length;
  const end = endRange.toString().length;
  return start <= end ? { start, end } : { start: end, end: start };
}

function getTextNodePosition(root: HTMLElement, target: number): { node: Text | HTMLElement; offset: number } {
  let consumed = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let current = walker.nextNode();
  let lastTextNode: Text | null = null;
  while (current) {
    const textNode = current as Text;
    const length = textNode.nodeValue?.length ?? 0;
    if (target <= consumed + length) {
      return {
        node: textNode,
        offset: Math.max(0, target - consumed)
      };
    }
    consumed += length;
    lastTextNode = textNode;
    current = walker.nextNode();
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.nodeValue?.length ?? 0
    };
  }

  return {
    node: root,
    offset: 0
  };
}

function restoreSelectionRange(root: HTMLElement, selectionRange: SelectionRange) {
  const total = root.textContent?.length ?? 0;
  const safeStart = Math.max(0, Math.min(total, selectionRange.start));
  const safeEnd = Math.max(0, Math.min(total, selectionRange.end));
  const startPos = getTextNodePosition(root, safeStart);
  const endPos = getTextNodePosition(root, safeEnd);

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const RichColorTextField = forwardRef<RichColorTextFieldHandle, RichColorTextFieldProps>(function RichColorTextField(
  { id, segments, defaultColor, disabled, onChangeSegments },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<SelectionRange | null>(null);
  const segmentsRef = useRef<TextSegment[]>([]);
  const safeDefaultColor = useMemo(() => normalizeHexColor(defaultColor, "#000000"), [defaultColor]);
  const [insertionColor, setInsertionColor] = useState(safeDefaultColor);
  const insertionColorRef = useRef(safeDefaultColor);
  const normalizedSegments = useMemo(
    () => ensureEditorSegments(segments, safeDefaultColor, getPreferredEmptyColor(segments, safeDefaultColor)),
    [segments, safeDefaultColor]
  );

  const setActiveInsertionColor = useCallback(
    (rawColor: string) => {
      const safeColor = normalizeHexColor(rawColor, safeDefaultColor);
      insertionColorRef.current = safeColor;
      setInsertionColor((prev) => (prev === safeColor ? prev : safeColor));
    },
    [safeDefaultColor]
  );

  useEffect(() => {
    const plainText = getPlainTextFromSegments(normalizedSegments);
    if (plainText.length === 0) {
      setActiveInsertionColor(normalizedSegments[0]?.color ?? safeDefaultColor);
    }
    segmentsRef.current = normalizedSegments;
  }, [normalizedSegments, safeDefaultColor, setActiveInsertionColor]);

  const commitSegments = useCallback(
    (next: TextSegment[], options?: { selection?: SelectionRange | null; emptyColor?: string | null }) => {
      if (options && "selection" in options) {
        pendingSelectionRef.current = options.selection ?? null;
      }
      const safeEmptyColor = normalizeHexColor(options?.emptyColor ?? insertionColorRef.current, safeDefaultColor);
      const normalized = ensureEditorSegments(next, safeDefaultColor, safeEmptyColor);
      segmentsRef.current = normalized;
      onChangeSegments(normalized);
    },
    [onChangeSegments, safeDefaultColor]
  );

  const applySelectionColor = useCallback(
    (color: string): boolean => {
      const root = rootRef.current;
      if (!root || disabled) return false;
      const safeColor = normalizeHexColor(color, safeDefaultColor);
      const selectionRange = getSelectionRange(root);
      const currentSegments = segmentsRef.current;
      const plainText = getPlainTextFromSegments(currentSegments);
      setActiveInsertionColor(safeColor);

      if (selectionRange && selectionRange.start !== selectionRange.end) {
        const next = applyColorToRange(
          currentSegments,
          selectionRange.start,
          selectionRange.end,
          safeColor,
          safeDefaultColor
        );
        commitSegments(next, { selection: selectionRange, emptyColor: safeColor });
      } else if (plainText.length === 0) {
        commitSegments([{ text: "", color: safeColor }], {
          selection: { start: 0, end: 0 },
          emptyColor: safeColor
        });
      }

      root.focus();
      return true;
    },
    [commitSegments, disabled, safeDefaultColor, setActiveInsertionColor]
  );

  useImperativeHandle(
    ref,
    () => ({
      applyColorToSelection: (color: string) => applySelectionColor(color)
    }),
    [applySelectionColor]
  );

  const replaceCurrentSelection = useCallback(
    (insertedText: string) => {
      const root = rootRef.current;
      if (!root || disabled) return;
      const currentSegments = segmentsRef.current;
      const currentText = getPlainTextFromSegments(currentSegments);
      const selectionRange =
        getSelectionRange(root) ??
        ({
          start: currentText.length,
          end: currentText.length
        } satisfies SelectionRange);
      const activeColor = insertionColorRef.current;
      const next = replaceTextRangeInSegmentsWithColor(
        currentSegments,
        selectionRange.start,
        selectionRange.end,
        insertedText,
        activeColor,
        safeDefaultColor
      );
      const cursor = selectionRange.start + insertedText.length;
      commitSegments(next, {
        selection: { start: cursor, end: cursor },
        emptyColor: activeColor
      });
    },
    [commitSegments, disabled, safeDefaultColor]
  );

  const handleInput = useCallback(() => {
    const root = rootRef.current;
    if (!root || disabled) return;
    const currentSegments = segmentsRef.current;
    const activeColor = insertionColorRef.current;
    const nextPlainText = root.textContent ?? "";
    const next = reconcileSegmentsWithPlainTextAndColor(currentSegments, nextPlainText, activeColor, safeDefaultColor);
    const selectionRange = getSelectionRange(root);
    commitSegments(next, {
      selection: selectionRange,
      emptyColor: activeColor
    });

    if (selectionRange && selectionRange.start === selectionRange.end) {
      const caretColor = getColorForInsertion(next, selectionRange.start, safeDefaultColor);
      setActiveInsertionColor(caretColor);
    } else if (getPlainTextFromSegments(next).length === 0) {
      setActiveInsertionColor(next[0]?.color ?? activeColor);
    }
  }, [commitSegments, disabled, safeDefaultColor, setActiveInsertionColor]);

  const handleBlur = useCallback(() => {
    const root = rootRef.current;
    if (!root || disabled) return;
    const currentSegments = segmentsRef.current;
    const activeColor = insertionColorRef.current;
    const nextPlainText = root.textContent ?? "";
    const next = reconcileSegmentsWithPlainTextAndColor(currentSegments, nextPlainText, activeColor, safeDefaultColor);
    commitSegments(next, { selection: null, emptyColor: activeColor });
  }, [commitSegments, disabled, safeDefaultColor]);

  const syncInsertionColorFromCaret = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const selectionRange = getSelectionRange(root);
    if (!selectionRange || selectionRange.start !== selectionRange.end) return;
    const caretColor = getColorForInsertion(segmentsRef.current, selectionRange.start, safeDefaultColor);
    setActiveInsertionColor(caretColor);
  }, [safeDefaultColor, setActiveInsertionColor]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const plain = event.clipboardData.getData("text/plain") ?? "";
      replaceCurrentSelection(plain);
    },
    [replaceCurrentSelection]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      replaceCurrentSelection("\n");
    },
    [replaceCurrentSelection]
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const modelSegments = normalizedSegments;
    const modelText = getPlainTextFromSegments(modelSegments);
    const pendingSelection = pendingSelectionRef.current ?? getSelectionRange(root);
    const requiresSync = (root.textContent ?? "") !== modelText || !domMatchesSegments(root, modelSegments);

    if (requiresSync) {
      root.replaceChildren(buildFragmentFromSegments(document, modelSegments));
    }
    if (pendingSelection) {
      restoreSelectionRange(root, pendingSelection);
    }
    pendingSelectionRef.current = null;
  }, [normalizedSegments]);

  return (
    <div
      id={id}
      ref={rootRef}
      className="rich-color-text-field"
      role="textbox"
      aria-multiline="true"
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
      onBlur={handleBlur}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onMouseUp={syncInsertionColorFromCaret}
      onKeyUp={syncInsertionColorFromCaret}
      onFocus={syncInsertionColorFromCaret}
      data-insertion-color={insertionColor}
    />
  );
});
