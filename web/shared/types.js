export const DEFAULT_LAYERS = [
    { name: '草稿', visible: true },
    { name: '线稿', visible: true },
    { name: '批注', visible: true },
];
export function defaultBoard() {
    return {
        width: 1600,
        height: 1000,
        grid: true,
        layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
        activeLayer: '草稿',
        elements: [],
    };
}
