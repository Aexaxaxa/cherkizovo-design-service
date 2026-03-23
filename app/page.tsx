"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";

import { AppIcon, BrandLogo, LoadingMark, getTemplateNetwork, selectionSteps } from "./ui";

type TemplateItem = {
  id: string;
  name: string;
  page: string;
  previewSignedUrl: string | null;
};

type SelectionGroupKey = "vk" | "start" | "ok";
type RailVariant = "vk" | "start" | "ok";

type SelectionGroup = {
  key: SelectionGroupKey;
  title: string;
  variant: RailVariant;
};

type DragState =
  | {
      mode: "content" | "thumb";
      startX: number;
      startScrollLeft: number;
      maxScrollLeft: number;
      moved: boolean;
    }
  | null;

const SELECTION_REFERENCE = {
  width: 1920,
  height: 1080,
  mobileBreakpoint: 980
} as const;

type SelectionViewportState = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  scale: number;
  isMobile: boolean;
};

function getSelectionViewportState(width: number, height: number): SelectionViewportState {
  const safeWidth = width > 0 ? width : SELECTION_REFERENCE.width;
  const safeHeight = height > 0 ? height : SELECTION_REFERENCE.height;
  const scaleX = safeWidth / SELECTION_REFERENCE.width;
  const scaleY = safeHeight / SELECTION_REFERENCE.height;

  return {
    width: safeWidth,
    height: safeHeight,
    scaleX,
    scaleY,
    scale: Math.min(scaleX, scaleY),
    isMobile: safeWidth < SELECTION_REFERENCE.mobileBreakpoint
  };
}

const SELECTION_GROUPS: SelectionGroup[] = [
  { key: "vk", title: "Вконтакте", variant: "vk" },
  { key: "start", title: "Старт", variant: "start" },
  { key: "ok", title: "Одноклассники", variant: "ok" }
];

function toUserError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : "Не удалось загрузить шаблоны";
  console.error("[templates]", error);
  if (message.includes("No snapshot")) return { code: "E_TEMPLATES_UNAVAILABLE", message: "Шаблоны временно недоступны" };
  return { code: "E_TEMPLATES_LOAD_FAILED", message: "Не удалось загрузить шаблоны" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function TemplateRail({
  items,
  variant,
  brokenImages,
  onImageError
}: {
  items: TemplateItem[];
  variant: RailVariant;
  brokenImages: Record<string, boolean>;
  onImageError: (templateId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const [thumb, setThumb] = useState({ width: 100, offset: 0, canScroll: false });
  const [isDragging, setIsDragging] = useState(false);

  const clearSuppressClickTimer = useCallback(() => {
    if (suppressClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressClickTimeoutRef.current);
      suppressClickTimeoutRef.current = null;
    }
  }, []);

  const updateThumb = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const maxScrollLeft = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
    if (maxScrollLeft <= 0 || scroller.scrollWidth <= 0) {
      setThumb({ width: 100, offset: 0, canScroll: false });
      return;
    }

    const visibleRatio = scroller.clientWidth / scroller.scrollWidth;
    const width = clamp(visibleRatio * 100, 16, 100);
    const travel = 100 - width;
    const offset = travel * (scroller.scrollLeft / maxScrollLeft);
    setThumb({ width, offset, canScroll: true });
  }, []);

  useEffect(() => {
    updateThumb();

    const handleResize = () => updateThumb();
    window.addEventListener("resize", handleResize);

    const scroller = scrollRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => updateThumb());

    if (scroller) {
      resizeObserver?.observe(scroller);
      Array.from(scroller.children).forEach((child) => {
        if (child instanceof HTMLElement) {
          resizeObserver?.observe(child);
        }
      });
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      clearSuppressClickTimer();
    };
  }, [clearSuppressClickTimer, items.length, updateThumb]);

  const finishDrag = useCallback(() => {
    const dragState = dragStateRef.current;
    dragStateRef.current = null;
    setIsDragging(false);

    if (dragState?.moved) {
      suppressClickRef.current = true;
      clearSuppressClickTimer();
      suppressClickTimeoutRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimeoutRef.current = null;
      }, 160);
    }
  }, [clearSuppressClickTimer]);

  const handleScrollerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest("[data-scroll-thumb='true']")) return;

    const scroller = scrollRef.current;
    if (!scroller) return;

    clearSuppressClickTimer();
    suppressClickRef.current = false;
    dragStateRef.current = {
      mode: "content",
      startX: event.clientX,
      startScrollLeft: scroller.scrollLeft,
      maxScrollLeft: Math.max(scroller.scrollWidth - scroller.clientWidth, 0),
      moved: false
    };

    scroller.setPointerCapture?.(event.pointerId);
  }, [clearSuppressClickTimer]);

  const handleScrollerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    const scroller = scrollRef.current;
    if (!dragState || dragState.mode !== "content" || !scroller) return;

    const delta = event.clientX - dragState.startX;
    if (!dragState.moved && Math.abs(delta) > 4) {
      dragState.moved = true;
      setIsDragging(true);
    }

    if (!dragState.moved) return;

    event.preventDefault();
    scroller.scrollLeft = clamp(dragState.startScrollLeft - delta, 0, dragState.maxScrollLeft);
    updateThumb();
  }, [updateThumb]);

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const scroller = scrollRef.current;
    if (!scroller) return;

    event.preventDefault();
    event.stopPropagation();

    clearSuppressClickTimer();
    suppressClickRef.current = false;
    dragStateRef.current = {
      mode: "thumb",
      startX: event.clientX,
      startScrollLeft: scroller.scrollLeft,
      maxScrollLeft: Math.max(scroller.scrollWidth - scroller.clientWidth, 0),
      moved: false
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [clearSuppressClickTimer]);

  const handleThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    const scroller = scrollRef.current;
    const track = trackRef.current;
    if (!dragState || dragState.mode !== "thumb" || !scroller || !track) return;

    const delta = event.clientX - dragState.startX;
    if (!dragState.moved && Math.abs(delta) > 2) {
      dragState.moved = true;
      setIsDragging(true);
    }

    const thumbWidthPx = (thumb.width / 100) * track.clientWidth;
    const thumbTravelPx = Math.max(track.clientWidth - thumbWidthPx, 1);
    const nextScrollLeft = dragState.startScrollLeft + (delta / thumbTravelPx) * dragState.maxScrollLeft;
    scroller.scrollLeft = clamp(nextScrollLeft, 0, dragState.maxScrollLeft);
    updateThumb();
  }, [thumb.width, updateThumb]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;

    const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (dominantDelta === 0) return;

    event.preventDefault();
    scroller.scrollLeft += dominantDelta;
    updateThumb();
  }, [updateThumb]);

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div className="selection-rail">
      <div
        ref={scrollRef}
        className={`selection-group__scroller selection-group__scroller--interactive selection-group__scroller--${variant}${isDragging ? " is-dragging" : ""}`}
        onClickCapture={handleClickCapture}
        onPointerCancel={finishDrag}
        onPointerDown={handleScrollerPointerDown}
        onPointerMove={handleScrollerPointerMove}
        onPointerUp={finishDrag}
        onScroll={updateThumb}
        onWheel={handleWheel}
      >
        {items.map((template) => {
          const hasImage = template.previewSignedUrl && !brokenImages[template.id];

          return (
            <Link
              aria-label={`Открыть шаблон ${template.name}`}
              className={`template-tile template-tile--${variant}`}
              draggable={false}
              href={`/t/${encodeURIComponent(template.id)}`}
              key={template.id}
            >
              {hasImage ? (
                <img
                  alt=""
                  className="template-tile__image"
                  draggable={false}
                  src={template.previewSignedUrl as string}
                  onError={() => onImageError(template.id)}
                />
              ) : (
                <div aria-hidden="true" className="template-tile__fallback" />
              )}
            </Link>
          );
        })}
      </div>

      <div className="selection-progress" ref={trackRef}>
        <div
          aria-hidden="true"
          className={`selection-progress__value${thumb.canScroll ? "" : " is-static"}`}
          data-scroll-thumb="true"
          onPointerCancel={finishDrag}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={finishDrag}
          style={{
            width: `${thumb.width}%`,
            left: `${thumb.offset}%`
          }}
        />
      </div>
    </div>
  );
}

export default function HomePage() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [status, setStatus] = useState("Loading templates...");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});
  const [selectionViewport, setSelectionViewport] = useState<SelectionViewportState>(() =>
    getSelectionViewportState(SELECTION_REFERENCE.width, SELECTION_REFERENCE.height)
  );

  const handleImageError = useCallback((templateId: string) => {
    setBrokenImages((prev) => ({
      ...prev,
      [templateId]: true
    }));
  }, []);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus("Loading templates...");

    try {
      const response = await fetch("/api/templates", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | TemplateItem[] | null;

      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && !Array.isArray(payload) && payload.error
            ? payload.error
            : `Failed to load templates: ${response.status}`
        );
      }

      if (!Array.isArray(payload)) {
        throw new Error("Templates response has invalid format");
      }

      setTemplates(payload);
      setStatus(payload.length > 0 ? "Templates loaded" : "No templates found");
    } catch (err) {
      const friendly = toUserError(err);
      setError(friendly);
      setStatus(friendly.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    const syncViewport = () => {
      setSelectionViewport(getSelectionViewportState(window.innerWidth, window.innerHeight));
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);

    return () => {
      window.removeEventListener("resize", syncViewport);
    };
  }, []);

  const groupedTemplates = useMemo(() => {
    return SELECTION_GROUPS.map((group) => ({
      ...group,
      items: templates.filter((template) => getTemplateNetwork(template.name) === group.key)
    }));
  }, [templates]);

  const selectionScreenStyle = useMemo(
    () =>
      ({
        "--selection-scale": `${selectionViewport.scale}`,
        "--selection-scale-x": `${selectionViewport.scaleX}`,
        "--selection-scale-y": `${selectionViewport.scaleY}`,
        "--selection-viewport-width": `${selectionViewport.width}px`,
        "--selection-viewport-height": `${selectionViewport.height}px`
      }) as CSSProperties,
    [selectionViewport]
  );

  const stepIconSize = selectionViewport.isMobile ? 38 : Math.max(18, Math.round(42 * selectionViewport.scale));

  return (
    <main
      aria-busy={loading}
      className={`screen-page screen-page--selection${selectionViewport.isMobile ? " is-mobile" : ""}`}
      style={selectionScreenStyle}
    >
      <div aria-live="polite" className="visually-hidden">
        {status}
      </div>

      <section className="screen-card screen-card--selection">
        <section className="selection-main">
          <h1 className="screen-title">Выберите шаблон</h1>

          <div className="selection-main__body ui-scroll">
            <div className="selection-groups">
              {groupedTemplates.map((group) => (
                <section className="selection-group" key={group.key}>
                  <h2 className="selection-group__title">{group.title}</h2>

                  <div className="selection-group__card">
                    <TemplateRail
                      brokenImages={brokenImages}
                      items={group.items}
                      onImageError={handleImageError}
                      variant={group.variant}
                    />
                  </div>
                </section>
              ))}
            </div>
          </div>
        </section>

        <aside className="selection-sidebar">
          <div className="selection-sidebar__logo-area">
            <BrandLogo className="brand-logo" tone="white" />
          </div>

          <div className="selection-sidebar__title-area">
            <p className="service-title">СЕРВИС ДЛЯ ГЕНЕРАЦИИ МАКЕТОВ ДЛЯ СОЦСЕТЕЙ</p>
          </div>

          <div className="selection-sidebar__steps-area">
            <section className="steps-panel">
              <div className="steps-panel__grid">
                {selectionSteps.map((step) => (
                  <div className="steps-panel__item" key={step.label}>
                    <AppIcon className="steps-panel__icon" name={step.icon} size={stepIconSize} tone="red" />
                    <p className="steps-panel__text">{step.label}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </section>

      {loading ? (
        <div className="editor-overlay" role="presentation">
          <div className="loading-card">
            <LoadingMark />
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="templates-error-title">
          <div className="warning-modal">
            <div className="warning-modal__header">
              <AppIcon name="warning" size={42} tone="red" />
              <h2 className="warning-modal__title" id="templates-error-title">
                Не удалось загрузить шаблоны
              </h2>
            </div>
            <p className="warning-modal__message">{error.message}</p>
            <button className="ui-action-button ui-action-button--primary" type="button" onClick={() => void loadTemplates()}>
              <span className="ui-action-button__label">Повторить</span>
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
