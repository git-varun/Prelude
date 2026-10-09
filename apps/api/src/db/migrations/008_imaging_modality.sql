-- m3-backlog #3: granular imaging report types. Purely descriptive metadata
-- for this round -- the existing radiology_impression/disease_status_trend
-- extraction prompt already extracts the narrative impression generically
-- regardless of scan type, so no extraction/prompt changes accompany this.
ALTER TABLE documents
  ADD COLUMN imaging_modality TEXT CHECK (
    imaging_modality IN ('ct', 'ct_contrast', 'mri', 'mri_contrast', 'pet_ct', 'ultrasound', 'xray', 'mammography', 'other')
  );
