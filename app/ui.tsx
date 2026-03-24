"use client";

import type { CSSProperties } from "react";

import angleLeftRed from "@/assets/icons/fi-rr-angle-small-left-red.svg";
import angleLeftWhite from "@/assets/icons/fi-rr-angle-small-left-white.svg";
import checkboxWhite from "@/assets/icons/fi-rr-checkbox-white.svg";
import confettiRed from "@/assets/icons/fi-rr-confetti-red.svg";
import confettiWhite from "@/assets/icons/fi-rr-confetti-white.svg";
import crossSmallWhite from "@/assets/icons/fi-rr-cross-small-white.svg";
import downloadRed from "@/assets/icons/fi-rr-download-red.svg";
import downloadWhite from "@/assets/icons/fi-rr-download-white.svg";
import editRed from "@/assets/icons/fi-rr-edit-red.svg";
import exclamationRed from "@/assets/icons/fi-rr-exclamation-red.svg";
import fileAddRed from "@/assets/icons/fi-rr-file-add-red.svg";
import folderAddWhite from "@/assets/icons/fi-rr-folder-add-white.svg";
import galleryRed from "@/assets/icons/fi-rr-gallery-red.svg";
import letterCaseRed from "@/assets/icons/fi-rr-letter-case-red.svg";
import letterCaseWhite from "@/assets/icons/fi-rr-letter-case-white.svg";
import minusSmallRed from "@/assets/icons/fi-rr-minus-small-red.svg";
import minusSmallWhite from "@/assets/icons/fi-rr-minus-small-white.svg";
import modeLandscapeRed from "@/assets/icons/fi-rr-mode-landscape-red.svg";
import modeLandscapeWhite from "@/assets/icons/fi-rr-mode-landscape-white.svg";
import pictureRed from "@/assets/icons/fi-rr-gallery-red.svg";
import plusSmallRed from "@/assets/icons/fi-rr-plus-small-red.svg";
import plusSmallWhite from "@/assets/icons/fi-rr-plus-small-white.svg";
import refreshBlack from "@/assets/icons/fi-rr-refresh-black.svg";
import loader from "@/assets/icons/loader.svg";
import logoRed from "@/assets/icons/logo-red.svg";
import logoWhite from "@/assets/icons/logo-white.svg";

type AssetLike = string | { src: string };

export type IconTone = "red" | "white" | "black";

export type IconName =
  | "back"
  | "close"
  | "confirm"
  | "create"
  | "crop"
  | "download"
  | "edit"
  | "folder"
  | "gallery"
  | "generate"
  | "letterCase"
  | "minus"
  | "plus"
  | "refresh"
  | "selectTemplate"
  | "text"
  | "upload"
  | "warning";

type IconProps = {
  name: IconName;
  tone?: IconTone;
  className?: string;
  size?: number;
  title?: string;
};

type TemplateNetwork = "vk" | "start" | "ok" | "other";

type StepItem = {
  icon: IconName;
  label: string;
};

const iconRegistry: Record<IconName, Partial<Record<IconTone, AssetLike>>> = {
  back: {
    red: angleLeftWhite,
    white: angleLeftRed
  },
  close: {
    red: crossSmallWhite,
    white: crossSmallWhite
  },
  confirm: {
    white: checkboxWhite
  },
  create: {
    red: confettiRed,
    white: confettiWhite
  },
  crop: {
    red: modeLandscapeRed,
    white: modeLandscapeWhite
  },
  download: {
    red: downloadRed,
    white: downloadWhite
  },
  edit: {
    red: editRed
  },
  folder: {
    red: folderAddWhite,
    white: folderAddWhite
  },
  gallery: {
    red: galleryRed
  },
  generate: {
    red: confettiRed,
    white: confettiWhite
  },
  letterCase: {
    red: letterCaseRed,
    white: letterCaseWhite
  },
  minus: {
    red: minusSmallRed,
    white: minusSmallWhite
  },
  plus: {
    red: plusSmallRed,
    white: plusSmallWhite
  },
  refresh: {
    red: refreshBlack,
    black: refreshBlack
  },
  selectTemplate: {
    red: pictureRed
  },
  text: {
    red: letterCaseRed,
    white: letterCaseWhite
  },
  upload: {
    red: fileAddRed
  },
  warning: {
    red: exclamationRed
  }
};

const toneColors: Record<IconTone, string> = {
  red: "#CE0037",
  white: "#FFFFFF",
  black: "#000000"
};

function getAssetUrl(asset: AssetLike): string {
  return typeof asset === "string" ? asset : asset.src;
}

function getIconAsset(name: IconName, tone: IconTone): string {
  const entry = iconRegistry[name];
  const asset = entry[tone] ?? entry.red ?? entry.white ?? entry.black;
  if (!asset) {
    throw new Error(`Missing icon asset for "${name}"`);
  }
  return getAssetUrl(asset);
}

export function AppIcon({ name, tone = "red", className, size = 40, title }: IconProps) {
  const mask = getIconAsset(name, tone);
  const style = {
    "--icon-mask": `url("${mask}")`,
    "--icon-color": toneColors[tone],
    width: `${size}px`,
    height: `${size}px`
  } as CSSProperties;

  return <span aria-hidden={title ? undefined : "true"} title={title} className={`app-icon${className ? ` ${className}` : ""}`} style={style} />;
}

export function LoadingMark({ className }: { className?: string }) {
  return <img className={`loading-mark${className ? ` ${className}` : ""}`} src={getAssetUrl(loader)} alt="" aria-hidden="true" />;
}

export function BrandLogo({ tone = "white", className }: { tone?: "white" | "red"; className?: string }) {
  const asset = tone === "white" ? logoWhite : logoRed;
  return <img className={className ?? "brand-logo"} src={getAssetUrl(asset)} alt="" aria-hidden="true" />;
}

export function getTemplateNetwork(name: string): TemplateNetwork {
  const normalized = name.trim().toLowerCase();
  if (normalized.startsWith("tpl_vk_")) return "vk";
  if (normalized.startsWith("tpl_ok_")) return "ok";
  if (normalized.startsWith("tpl_start_")) return "start";
  return "other";
}

export function getNetworkLabel(network: TemplateNetwork): string {
  if (network === "vk") return "Вконтакте";
  if (network === "start") return "Старт";
  if (network === "ok") return "Одноклассники";
  return "Другие";
}

export const selectionSteps: StepItem[] = [
  { icon: "selectTemplate", label: "Выбери \n шаблон" },
  { icon: "upload", label: "Загрузи/выбери\nфото" },
  { icon: "text", label: "Заполни шаблон\nконтентом" },
  { icon: "crop", label: "Обрежь фото \n под шаблон" },
  { icon: "generate", label: "Сгенерируй\nмакет" },
  { icon: "download", label: "Скачай\nмакет" }
];
