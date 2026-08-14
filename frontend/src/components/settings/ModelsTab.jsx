import ModelFavorites from './ModelFavorites.jsx';
import { IMAGE_MODEL_PROVIDERS, MODEL_PROVIDERS, VIDEO_MODEL_PROVIDERS } from './modelProviders.js';

// Settings > "Models": the five favorites panels (text, simple text, image,
// simple image, video). The catalogs themselves are fetched by
// SettingsScreen.jsx and passed in.
export default function ModelsTab({
  L, textModels, simpleModels, imageModels, imageModelsSimple, videoModels,
  catalog, imageCatalog, videoCatalog,
  refreshingModels, refreshingImageModels, refreshingVideoModels,
  onRefreshModels, onRefreshImageModels, onRefreshVideoModels,
  priceMap, actions,
}) {
  return (
    <>
      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_textModels}</div>
        <ModelFavorites
          L={L} providers={MODEL_PROVIDERS}
          favorites={textModels.favorites} defaultValue={textModels.default}
          catalog={catalog} refreshing={refreshingModels} onRefresh={onRefreshModels}
          prices={priceMap}
          onAddFavorite={actions.addTextModelFavorite}
          onRemoveFavorite={actions.removeTextModelFavorite}
          onSetDefault={actions.setTextModelDefault}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_simpleModels}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_simpleModelsHint}</div>
        <ModelFavorites
          L={L} providers={MODEL_PROVIDERS}
          favorites={simpleModels.favorites} defaultValue={simpleModels.default}
          catalog={catalog} refreshing={refreshingModels} onRefresh={onRefreshModels}
          prices={priceMap}
          onAddFavorite={actions.addSimpleModelFavorite}
          onRemoveFavorite={actions.removeSimpleModelFavorite}
          onSetDefault={actions.setSimpleModelDefault}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_imageModels}</div>
        <ModelFavorites
          L={L} providers={IMAGE_MODEL_PROVIDERS}
          favorites={imageModels.favorites} defaultValue={imageModels.default}
          catalog={imageCatalog} refreshing={refreshingImageModels} onRefresh={onRefreshImageModels}
          prices={priceMap}
          onAddFavorite={actions.addImageModelFavorite}
          onRemoveFavorite={actions.removeImageModelFavorite}
          onSetDefault={actions.setImageModelDefault}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_imageModelsSimple}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_imageModelsSimpleHint}</div>
        <ModelFavorites
          L={L} providers={IMAGE_MODEL_PROVIDERS}
          favorites={imageModelsSimple.favorites} defaultValue={imageModelsSimple.default}
          catalog={imageCatalog} refreshing={refreshingImageModels} onRefresh={onRefreshImageModels}
          prices={priceMap}
          onAddFavorite={actions.addImageModelSimpleFavorite}
          onRemoveFavorite={actions.removeImageModelSimpleFavorite}
          onSetDefault={actions.setImageModelSimpleDefault}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_videoModels}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{L.settings_videoModelsHint}</div>
        <ModelFavorites
          L={L} providers={VIDEO_MODEL_PROVIDERS}
          favorites={videoModels.favorites} defaultValue={videoModels.default}
          catalog={videoCatalog} refreshing={refreshingVideoModels} onRefresh={onRefreshVideoModels}
          prices={priceMap}
          onAddFavorite={actions.addVideoModelFavorite}
          onRemoveFavorite={actions.removeVideoModelFavorite}
          onSetDefault={actions.setVideoModelDefault}
        />
      </div>
    </>
  );
}
