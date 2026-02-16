declare module "opentype.js" {
  export type Font = {
    getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number;
  };

  export function parse(buffer: ArrayBuffer): Font;
}
