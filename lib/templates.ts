export type TemplateDefinition = {
  id: "TPL_vk_post_1";
  figmaFileKey: "4BW7ipWiRs4gS5ldAWwFON";
  frameNodeId: "1:7";
  titleFields: "title";
  hasPhoto: true;
};

export const templatesRegistry: TemplateDefinition[] = [
  {
    id: "TPL_vk_post_1",
    figmaFileKey: "4BW7ipWiRs4gS5ldAWwFON",
    frameNodeId: "1:7",
    titleFields: "title",
    hasPhoto: true
  }
];

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return templatesRegistry.find((template) => template.id === id);
}
