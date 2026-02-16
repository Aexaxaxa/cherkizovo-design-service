export const TPL_VK_POST_1_ID = "TPL_vk_post_1" as const;

export const TPL_VK_POST_1_FIGMA = {
  frame: {
    width: 2000,
    height: 2000,
    background: {
      r: 0.8078431487,
      g: 0,
      b: 0.2156862766,
      a: 1
    }
  },
  nodes: {
    logoBgId: "1:8",
    photoId: "1:9",
    textBlockId: "1:10",
    textId: "1:11",
    logoVectorId: "I1:12;1:279"
  },
  layout: {
    logoBg: { x: -418, y: -82, width: 2912, height: 2164, opacity: 0.1 },
    photo: { x: 150, y: 350, width: 1850, height: 1420, radii: [120, 0, 0, 0] as [number, number, number, number] },
    textBlock: {
      x: 0,
      y: 1490,
      width: 1381,
      height: 380,
      radii: [0, 60, 60, 0] as [number, number, number, number],
      fill: { r: 1, g: 1, b: 1, a: 1 },
      layoutMode: "VERTICAL" as const,
      paddingLeft: 150,
      paddingRight: 150,
      paddingTop: 80,
      paddingBottom: 80,
      itemSpacing: 50,
      blockBottom: 1870
    },
    logo: { x: 150, y: 100, width: 716, height: 150 }
  },
  textStyle: {
    fontPostScriptName: "GothamPro-Bold",
    fontSize: 110,
    fontWeight: 700,
    color: { r: 0, g: 0, b: 0, a: 1 },
    align: "LEFT" as const,
    lineHeightUnit: "PIXELS",
    lineHeightPercentFontSize: 100,
    lineHeightPercentFontSizeNormalized: 100,
    lineHeightPx: 110,
    letterSpacing: 0
  }
} as const;

export type TemplateId = typeof TPL_VK_POST_1_ID;

export type TemplateDefinition = {
  id: TemplateId;
  figmaFileKey: string;
  frameNodeId: string;
  titleFields: "title";
  hasPhoto: true;
};

export const templatesRegistry: TemplateDefinition[] = [
  {
    id: TPL_VK_POST_1_ID,
    figmaFileKey: "4BW7ipWiRs4gS5ldAWwFON",
    frameNodeId: "1:7",
    titleFields: "title",
    hasPhoto: true
  }
];

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return templatesRegistry.find((template) => template.id === id);
}
