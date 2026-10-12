import React, { useEffect, useMemo, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import { loadStrategyXml, publicXmlUrl } from '@/utils/bot-workspace';
import { Localize, localize } from '@deriv-com/translations';
import './best-bots.scss';

type TBotCategory = 'free' | 'automated';

type TBestBot = {
    id: string;
    name: string;
    description: string;
    category: TBotCategory;
    position: number;
    file: string;
    youtube_url?: string;
};

const botsUrl = (file: string) => publicXmlUrl(`best-bots/${file}`);

const CATEGORIES: { value: TBotCategory; label: string }[] = [
    { value: 'free', label: localize('Free Bots') },
    { value: 'automated', label: localize('Automated Bots') },
];

const BestBots = observer(() => {
    const { dashboard } = useStore();
    const [bots, setBots] = useState<TBestBot[]>([]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [category, setCategory] = useState<TBotCategory>('free');
    const [loading_id, setLoadingId] = useState<string | null>(null);
    const [load_error, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let is_active = true;
        fetch(botsUrl('bots.json'))
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json() as Promise<TBestBot[]>;
            })
            .then(list => {
                if (!is_active) return;
                setBots([...list].sort((a, b) => a.position - b.position));
                setStatus('ready');
            })
            .catch(() => is_active && setStatus('error'));
        return () => {
            is_active = false;
        };
    }, []);

    const visible_bots = useMemo(() => bots.filter(bot => bot.category === category), [bots, category]);

    const loadBot = async (bot: TBestBot) => {
        setLoadingId(bot.id);
        setLoadError(null);
        try {
            const response = await fetch(botsUrl(bot.file));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await loadStrategyXml(await response.text(), bot.name);
            dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
        } catch {
            setLoadError(localize('{{bot_name}} could not be loaded. Please try again.', { bot_name: bot.name }));
        } finally {
            setLoadingId(null);
        }
    };

    return (
        <div className='best-bots'>
            <div className='best-bots__header'>
                <h2 className='best-bots__title'>
                    <Localize i18n_default_text='Best Bots' />
                </h2>
                <p className='best-bots__subtitle'>
                    <Localize i18n_default_text='Click a bot to load it into the Bot Builder, then press Run.' />
                </p>
            </div>

            <div className='best-bots__tabs' role='tablist'>
                {CATEGORIES.map(({ value, label }) => (
                    <button
                        key={value}
                        type='button'
                        role='tab'
                        aria-selected={category === value}
                        className={classNames('best-bots__tab', { 'best-bots__tab--active': category === value })}
                        onClick={() => setCategory(value)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {load_error && <div className='best-bots__error'>{load_error}</div>}

            {status === 'loading' && (
                <p className='best-bots__state'>
                    <Localize i18n_default_text='Loading bots…' />
                </p>
            )}
            {status === 'error' && (
                <p className='best-bots__state'>
                    <Localize i18n_default_text='The bot list could not be loaded. Check your connection and refresh the page.' />
                </p>
            )}
            {status === 'ready' && !visible_bots.length && (
                <p className='best-bots__state'>
                    <Localize i18n_default_text='No bots in this category yet.' />
                </p>
            )}

            <div className='best-bots__grid'>
                {visible_bots.map((bot, index) => (
                    <div key={bot.id} className='best-bots__card'>
                        <h3 className='best-bots__card-title'>
                            {index + 1}. {bot.name}
                        </h3>
                        <p className='best-bots__card-description'>{bot.description}</p>
                        <div className='best-bots__card-actions'>
                            <button
                                type='button'
                                className='best-bots__load'
                                onClick={() => loadBot(bot)}
                                disabled={loading_id !== null}
                            >
                                {loading_id === bot.id ? localize('Loading…') : localize('Click to Load Bot')}
                            </button>
                            {bot.youtube_url && (
                                <a
                                    className='best-bots__video'
                                    href={bot.youtube_url}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                >
                                    <Localize i18n_default_text='Watch video' />
                                </a>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
});

export default BestBots;
