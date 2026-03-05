declare module "react-easy-crop" {
  import type { ComponentType } from "react";

  export type Area = {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  export type CropperProps = {
    image: string;
    crop: { x: number; y: number };
    zoom: number;
    aspect: number;
    cropSize?: { width: number; height: number };
    objectFit?: "contain" | "cover" | "horizontal-cover" | "vertical-cover";
    showGrid?: boolean;
    zoomWithScroll?: boolean;
    restrictPosition?: boolean;
    style?: {
      containerStyle?: Record<string, string | number>;
      mediaStyle?: Record<string, string | number>;
      cropAreaStyle?: Record<string, string | number>;
    };
    onCropChange: (crop: { x: number; y: number }) => void;
    onZoomChange?: (zoom: number) => void;
    onMediaLoaded?: (mediaSize: { width: number; height: number; naturalWidth?: number; naturalHeight?: number }) => void;
    onCropComplete?: (croppedArea: Area, croppedAreaPixels: Area) => void;
  };

  const Cropper: ComponentType<CropperProps>;
  export default Cropper;
}
