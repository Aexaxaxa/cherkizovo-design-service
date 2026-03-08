"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import {
  applyColorToRange,
  getPlainTextFromSegments,
  normalizeHexColor,
  normalizeSegments,
  reconcileSegmentsWithPlainText,
  replaceTextRangeInSegments,
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
  const safeDefaultColor = useMemo(() => normalizeHexColor(defaultColor, "#000000"), [defaultColor]);
  const normalizedSegments = useMemo(
    () => normalizeSegments(segments, safeDefaultColor),
    [segments, safeDefaultColor]
  );

  const commitSegments = useCallback(
    (next: TextSegment[], nextSelection?: SelectionRange | null) => {
      if (nextSelection) {
        pendingSelectionRef.current = nextSelection;
      }
      onChangeSegments(normalizeSegments(next, safeDefaultColor));
    },
    [onChangeSegments, safeDefaultColor]
  );

  const applySelectionColor = useCallback(
    (color: string): boolean => {
      const root = rootRef.current;
      if (!root || disabled) return false;
      const selectionRange = getSelectionRange(root);
      if (!selectionRange || selectionRange.start === selectionRange.end) return false;

      const next = applyColorToRange(
        normalizedSegments,
        selectionRange.start,
        selectionRange.end,
        color,
        safeDefaultColor
      );
      commitSegments(next, selectionRange);
      root.focus();
      return true;
    },
    [commitSegments, disabled, normalizedSegments, safeDefaultColor]
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
      const currentText = getPlainTextFromSegments(normalizedSegments);
      const selectionRange =
        getSelectionRange(root) ??
        ({
          start: currentText.length,
          end: currentText.length
        } satisfies SelectionRange);
      const next = replaceTextRangeInSegments(
        normalizedSegments,
        selectionRange.start,
        selectionRange.end,
        insertedText,
        safeDefaultColor
      );
      const cursor = selectionRange.start + insertedText.length;
      commitSegments(next, { start: cursor, end: cursor });
    },
    [commitSegments, disabled, normalizedSegments, safeDefaultColor]
  );

  const handleInput = useCallback(() => {
    const root = rootRef.current;
    if (!root || disabled) return;
    const nextPlainText = root.textContent ?? "";
    const next = reconcileSegmentsWithPlainText(normalizedSegments, nextPlainText, safeDefaultColor);
    const selectionRange = getSelectionRange(root);
    commitSegments(next, selectionRange);
  }, [commitSegments, disabled, normalizedSegments, safeDefaultColor]);

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
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    pendingSelectionRef.current = null;
    restoreSelectionRange(root, pending);
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
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
    >
      {normalizedSegments.map((segment, index) => (
        <span key={`${index}:${segment.color}:${segment.text.length}`} style={{ color: segment.color }}>
          {segment.text}
        </span>
      ))}
    </div>
  );
});
