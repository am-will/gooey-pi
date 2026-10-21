import { selectPet } from '@/lib/pets'
import { PawPrint, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { PetAvatar } from '@/components/PetAvatar'
import { GOOEYPI_MASCOT_SRC } from '@/lib/assets'
import { BUILT_IN_PET_COPY, BUILT_IN_PETS, petDisplayName } from '@/lib/built-in-pets'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { PetDefinition, PrimeWorkApi } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function PetsSettings({ settings, onUpdate, pets }: SettingsSectionProps & { pets: PrimeWorkApi['pets'] | null }) {
  const { t } = useI18n()
  const [available, setAvailable] = useState<PetDefinition[]>(BUILT_IN_PETS)
  const [loading, setLoading] = useState(false)
  // The key is stored instead of the message so the error follows the interface
  // language and the refresh callback stays independent of the translator.
  const [loadError, setLoadError] = useState<MessageKey | null>(null)
  const refresh = useCallback(async () => {
    if (!pets) return
    setLoading(true)
    setLoadError(null)
    try {
      const items = await pets.list()
      setAvailable(items.length ? items : BUILT_IN_PETS)
    } catch {
      setLoadError('settings.pets.codex.loadError')
      setAvailable(BUILT_IN_PETS)
    } finally { setLoading(false) }
  }, [pets])
  useEffect(() => { void refresh() }, [refresh])
  const selected = useMemo(() => selectPet(available, settings.petId), [available, settings.petId])
  const selectedCopy = BUILT_IN_PET_COPY[selected.id]
  const codexCount = available.filter((item) => item.source === 'codex').length

  return (
    <>
      <header><h1>{t('settings.pets')}</h1><p>{t('settings.pets.description')}</p></header>
      <section className="pet-hero">
        <div className="pet-hero__stage"><PetAvatar pet={selected} pets={pets} activity="speaking" size={Math.round(96 * settings.petSize / 100)} reduceMotion={settings.reduceMotion} /></div>
        <div><span className="pet-kicker"><Sparkles size={12} /> {t('settings.pets.activeCompanion')}</span><h2>{petDisplayName(selected, t)}</h2><p>{selectedCopy ? t(selectedCopy.description) : selected.description}</p><small>{t('settings.pets.dragDescription')}</small></div>
      </section>
      <section className="settings-group">
        <h2>{t('settings.pets.companion.title')}</h2>
        <SettingsToggle checked={settings.petEnabled} onChange={(petEnabled) => { void onUpdate({ petEnabled }) }} label={t('settings.pets.enabled.label')} description={t('settings.pets.enabled.description')} />
        <div className="settings-row pet-size-row">
          <span><label htmlFor="pet-size"><strong>{t('settings.pets.size.label')}</strong></label><small>{t('settings.pets.size.description')}</small></span>
          <div className="pet-size-control">
            <input id="pet-size" type="range" min="50" max="125" step="5" value={settings.petSize} style={{ '--pet-size-progress': `${(settings.petSize - 50) / .75}%` } as CSSProperties} onChange={(event) => { void onUpdate({ petSize: Number(event.target.value) }) }} />
            <output htmlFor="pet-size">{settings.petSize}%</output>
          </div>
        </div>
        <div className="pet-grid" role="radiogroup" aria-label={t('settings.pets.aria')}>
          {available.map((pet) => (
            <button
              type="button"
              role="radio"
              aria-checked={pet.id === selected.id}
              className={pet.id === selected.id ? 'pet-choice is-active' : 'pet-choice'}
              key={pet.id}
              onClick={() => { void onUpdate({ petId: pet.id, petEnabled: true }) }}
            >
              <span className="pet-choice__art">
                {pet.id === 'gooey-pi' ? <img src={GOOEYPI_MASCOT_SRC} alt="" /> : pet.kind === 'orb' ? <PetAvatar pet={pet} pets={pets} size={48} reduceMotion={settings.reduceMotion} /> : <PawPrint size={24} />}
              </span>
              <span><strong>{petDisplayName(pet, t)}</strong><small>{pet.source === 'built-in' ? t('settings.pets.builtIn') : t('settings.pets.codexPet')}</small></span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <div className="settings-group__heading"><h2>{t('settings.pets.codex.title')}</h2><button type="button" className="button button--compact" disabled={!pets || loading} onClick={() => { void refresh() }}><RefreshCw size={12} className={loading ? 'spin' : ''} /> {t('common.refresh')}</button></div>
        <p className="settings-group__description">{t('settings.pets.codex.descriptionLead')} <code>~/.codex/pets</code>{t('settings.pets.codex.descriptionTail')}</p>
        <div className="settings-row"><span><strong>{codexCount ? t('settings.pets.codex.found', { count: codexCount }) : t('settings.pets.codex.none')}</strong><small>{codexCount ? t('settings.pets.codex.availableHint') : t('settings.pets.codex.installHint')}</small></span></div>
        {loadError ? <p className="settings-error" role="alert">{t(loadError)}</p> : null}
      </section>
    </>
  )
}
