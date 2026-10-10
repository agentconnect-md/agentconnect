// Shared-image preview preparation (webchat-generated-images.md §5).
export {
  configurePreviewPool,
  DEFAULT_PREVIEW_POOL_LIMITS,
  prepareSharedImagePreview,
  resetPreviewPool,
  type PreparedPreview,
  type PreviewFailure,
  type PreviewFailureReason,
  type PreviewPoolLimits,
  type SharedImageMime
} from './preview.js'
export { sharedImageName, sniffSharedImage } from './sniff.js'
export { checkStaticSvg } from './svg-safety.js'
