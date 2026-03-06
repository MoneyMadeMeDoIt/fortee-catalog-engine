// Stub - to be implemented
export type DecorationMethod = 'Print' | 'Embroidery';
export type GarmentCategory = 'T-Shirt' | 'Hoodie' | 'Cap' | 'Beanie' | 'Pants' | 'Long Sleeve' | 'Jacket';
export interface DecorationPlacement {
  method: DecorationMethod;
  bodyCategory: string;
  placementName: string;
  commonSizes: string;
  maxSize: string;
  verticalRef: string;
  horizontalRef: string;
  notes: string;
}
