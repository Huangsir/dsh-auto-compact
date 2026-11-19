window.__ModuleLoader__.load({
	id: 'dsh-auto-compact',
	factory: (require) => {
		const React = require('react');
		const { SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField } = require('@deepseek-ai/dsh-client-ui-primitives');
		const CSS_ID = 'dsh-auto-compact/styles';
		const css = `.ac-ring{position:relative;display:inline-flex;align-items:center}
.ac-trigger{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;border-radius:999px;flex:none;place-items:center;display:grid;padding:0}
.ac-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ac-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}
.ac-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}
.ac-arc{fill:none;stroke:var(--dsw-alias-state-warn-primary,#f59e0b);stroke-width:2px;stroke-linecap:round}
.ac-panel{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-alias-bg-layer-3);background:rgb(from var(--dsw-alias-bg-layer-3) r g b / 1);width:248px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-secondary);cursor:default;border-radius:12px;padding:12px;font-size:12px;line-height:20px;position:absolute;bottom:calc(100% + 8px);right:0}
.ac-panel-title{color:var(--dsw-alias-label-primary);font-weight:500;font-size:13px}
.ac-slider{width:100%;accent-color:var(--dsw-alias-state-warn-primary,#f59e0b);margin:10px 0 4px}
.ac-panel-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 0}
.ac-panel-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500}
.ac-panel-hint{color:var(--dsw-alias-label-caption);margin-top:8px;font-size:11px;line-height:16px}
.ac-reset,.ac-discard{border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;cursor:pointer;margin-top:8px}
.ac-reset:hover,.ac-discard:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ac-reset:disabled,.ac-discard:disabled,.ac-slider:disabled{opacity:.5;cursor:default}
.ac-error{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px;margin-top:6px}`;
		if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) {
			const tag = document.createElement('style');
			tag.setAttribute('data-plugin-css', CSS_ID);
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const FIELDS = [
			['below300KPercent', '模型最大 Context 小于 300K', 80],
			['above800KPercent', '模型最大 Context 大于 800K', 30],
			['otherPercent', '其余情况', 50],
		];
		const RADIUS = 6.5;
		const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
		// 首次读取失败时的退避表（毫秒）。重启后宿主可能还没把该会话放进内存、或仍在启动，
		// 一次失败就停会让圆环一直停在“加载中”，直到用户切会话/切模型才自愈。
		const READ_RETRY_DELAYS = [400, 1000, 2500, 5000, 10000];
		const inject = ['slots', 'configForms'];

		async function request(method, body) {
			const response = await fetch('/dsh-auto-compact/api/' + method, {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
			});
			const parsed = await response.json();
			if (!response.ok || parsed?.ok !== true) throw new Error('threshold request failed');
			return parsed.value;
		}
		async function resolveThreshold(sessionId) {
			const value = await request('thresholds.resolve', { sessionId });
			if (!(typeof value?.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio > 0 && value.ratio <= 1)) throw new Error('threshold unavailable');
			return value;
		}

		function SettingsCard(props) {
			const state = props.useCompactSettings(snapshot => snapshot);
			if (props.view === 'summary') return null;
			const disabled = !state.writable || state.saving;
			return React.createElement(SettingsForm, {
				state,
				labels: { unavailable: '配置暂不可用', readOnly: '配置只读', saveFailed: '保存失败，请重试', save: 'Save', saving: '保存中…' },
				onSave: props.save, onDiscard: props.discard,
			},
				...FIELDS.map(([field, label, fallback]) => React.createElement(SettingsValueField, {
					key: field, id: 'ac-config-' + field, label, numeric: true, disabled,
					placeholder: String(fallback), hint: '整数百分比，范围 1–99',
					overriddenLabel: '已修改', resetLabel: 'Reset', invalidLabel: '请输入 1–99 的整数',
					...state.fields[field],
					onEdit: text => props.edit(field, text), onReset: () => props.resetField(field),
				})),
				React.createElement('button', { type: 'button', className: 'ac-discard', disabled: disabled || !state.dirty, onClick: props.discard }, 'Discard'),
			);
		}

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (!slots) return;
			let scope;
			try {
				scope = (ctx.configForms ?? ctx.get('configForms')).get('dsh-auto-compact');
				const form = new SettingsFormModel(scope, FIELDS.map(([field]) => {
					const spec = settingsNumberField(field);
					return { ...spec, parse: text => {
						const result = spec.parse(text);
						return result?.kind === 'clear' || (Number.isInteger(result?.value) && result.value >= 1 && result.value <= 99) ? result : undefined;
					} };
				}));
				const store = form.bind(() => ({ ...form.shell(), fields: Object.fromEntries(FIELDS.map(([field]) => [field, form.field(field)])) }));
				ctx.effect(() => () => form.dispose());
				slots.inject('plugins.bundle.config', () => slots.register({
					name: 'plugins.bundle.config', key: 'dsh-auto-compact',
					inject: () => ({ hooks: { compactSettings: store }, ...form.actions() }),
				}, SettingsCard));
			} catch (error) {
				console.error('[ac] configuration card unavailable', error);
			}

			function Ring(props) {
				const sessionId = props?.sessionId || props?.session?.sessionId;
				const useProjection = props?.useProjection;
				const modelSelection = useProjection ? useProjection('modelSelection') : null;
				const pressure = useProjection ? useProjection('contextPressure') : null;
				const configSnapshot = React.useSyncExternalStore(
					React.useCallback(listener => scope ? scope.subscribe(listener) : () => {}, []),
					React.useCallback(() => scope ? scope.getSnapshot() : null, []),
				);
				const selection = modelSelection?.next;
				const [open, setOpen] = React.useState(false);
				const [threshold, setThreshold] = React.useState(null);
				const [saving, setSaving] = React.useState(null);
				const [error, setError] = React.useState(null);
				const [sliderValue, setSliderValue] = React.useState(null);
				const ringRef = React.useRef(null);
				const currentSession = React.useRef({ id: sessionId });
				const readVersion = React.useRef(0);
				const pendingPercent = React.useRef(null);
				const flushing = React.useRef(false);
				if (currentSession.current?.id !== sessionId) currentSession.current = { id: sessionId };
				const ratio = threshold?.sessionId === sessionId ? threshold.ratio : null;
				const busy = saving === sessionId;
				const percent = ratio === null ? null : Math.round(ratio * 100);

				React.useEffect(() => {
					setOpen(false);
					setError(null);
					setSaving(null);
					setSliderValue(null);
				}, [sessionId]);
				React.useEffect(() => {
					if (sliderValue !== null && sliderValue === percent) setSliderValue(null);
				}, [sliderValue, percent]);
				React.useEffect(() => {
					if (!sessionId) return;
					let alive = true;
					let timer = null;
					const version = ++readVersion.current;
					const read = attempt => {
						resolveThreshold(sessionId).then(value => {
							if (alive && version === readVersion.current) {
								setThreshold({ sessionId, ...value });
								setError(null);
							}
						}).catch(() => {
							if (!alive || version !== readVersion.current) return;
							setError({ sessionId, message: '阈值读取失败，请重试' });
							// 有界退避重试：宿主把会话转成 live、或服务刚就绪后自行恢复，
							// 不再依赖用户切会话/切模型来触发重新读取。
							const delay = READ_RETRY_DELAYS[attempt];
							if (delay !== undefined) {
								timer = setTimeout(() => {
									if (alive && version === readVersion.current) read(attempt + 1);
								}, delay);
							}
						});
					};
					read(0);
					return () => { alive = false; if (timer !== null) clearTimeout(timer); };
				}, [sessionId, selection?.provider, selection?.model, configSnapshot?.revision, open]);
				React.useEffect(() => {
					if (!open) return;
					const closeOutside = event => {
						if (ringRef.current && !ringRef.current.contains(event.target)) setOpen(false);
					};
					document.addEventListener('pointerdown', closeOutside, true);
					document.addEventListener('click', closeOutside, true);
					return () => {
						document.removeEventListener('pointerdown', closeOutside, true);
						document.removeEventListener('click', closeOutside, true);
					};
				}, [open]);
				React.useEffect(() => () => { currentSession.current = null; readVersion.current++; }, []);

				const updateThreshold = async (method, next) => {
					if (!sessionId || busy) return;
					setSaving(sessionId);
					setError(null);
					readVersion.current++;
					const owner = currentSession.current;
					try {
						try {
							await request(method, { sessionId, ...(method === 'thresholds.set' ? { ratio: next } : {}) });
						} catch {
							if (currentSession.current === owner) {
								setError({ sessionId, message: '保存失败，请重试' });
								// The write was rejected; the thumb returns to the accepted value.
								setSliderValue(null);
							}
							return;
						}
						if (currentSession.current !== owner) return;
						// The mutation is accepted; re-read the authoritative value. A newer read
						// (model/config/session change) supersedes this one, including its failure.
						const version = ++readVersion.current;
						try {
							const value = await resolveThreshold(sessionId);
							if (currentSession.current === owner && version === readVersion.current) {
								setThreshold({ sessionId, ...value });
								setError(null);
							}
						} catch {
							if (currentSession.current === owner && version === readVersion.current) setError({ sessionId, message: '阈值读取失败，请重试' });
						}
					} finally {
						if (currentSession.current === owner) setSaving(null);
					}
				};
				// A drag fires one input event per 5% step. Writes serialize through a
				// single loop so the slider never disables mid-drag (a disabled input
				// would end the pointer gesture) and the final position always lands.
				const requestSet = nextPercent => {
					pendingPercent.current = nextPercent;
					if (flushing.current) return;
					flushing.current = true;
					void (async () => {
						try {
							while (pendingPercent.current !== null) {
								const value = pendingPercent.current;
								pendingPercent.current = null;
								await updateThreshold('thresholds.set', value / 100);
							}
						} finally { flushing.current = false; }
					})();
				};
				if (!sessionId) return null;
				const label = percent === null ? '自动压缩阈值加载中' : '自动压缩阈值 ' + percent + '%';
				const arc = (CIRCUMFERENCE * (ratio ?? 0)).toFixed(2) + ' ' + CIRCUMFERENCE.toFixed(2);
				const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
				const usagePercent = usedTokens != null && pressure?.contextWindow > 0 ? Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)) : null;
				return React.createElement('span', { className: 'ac-ring', ref: ringRef },
					React.createElement('button', { type: 'button', className: 'ac-trigger', 'aria-label': label, 'aria-expanded': open, title: label, onClick: () => setOpen(value => !value) },
						React.createElement('svg', { viewBox: '0 0 18 18', width: 16, height: 16, 'aria-hidden': true },
							React.createElement('circle', { className: 'ac-track', cx: 9, cy: 9, r: RADIUS }),
							React.createElement('circle', { className: 'ac-arc', cx: 9, cy: 9, r: RADIUS, strokeDasharray: arc, transform: 'rotate(-90 9 9)' }),
						),
					),
					open && React.createElement('div', { className: 'ac-panel', role: 'dialog', 'aria-label': '自动压缩阈值' },
						React.createElement('div', { className: 'ac-panel-title' }, '自动压缩阈值'),
						React.createElement('input', {
							type: 'range', className: 'ac-slider', 'aria-label': '触发阈值', min: 10, max: 90, step: 5,
							value: sliderValue ?? Math.max(10, Math.min(90, Math.round((percent ?? 50) / 5) * 5)), disabled: ratio === null,
							onInput: event => {
								const value = Math.max(10, Math.min(90, Math.round(Number(event.target.value) / 5) * 5));
								setSliderValue(value);
								requestSet(value);
							},
						}),
						React.createElement('div', { className: 'ac-panel-row' }, React.createElement('span', null, '触发阈值'), React.createElement('strong', { className: 'ac-panel-value' }, percent === null ? '加载中…' : percent + '%')),
						usagePercent !== null && React.createElement('div', { className: 'ac-panel-row' }, React.createElement('span', null, '当前用量'), React.createElement('span', { className: 'ac-panel-value' }, usagePercent + '%')),
						React.createElement('button', { type: 'button', className: 'ac-reset', disabled: ratio === null || busy || !threshold?.overridden, onClick: () => updateThreshold('thresholds.reset') }, '恢复默认'),
						error?.sessionId === sessionId && React.createElement('div', { className: 'ac-error', role: 'status' }, error.message),
						React.createElement('div', { className: 'ac-panel-hint' }, '超过阈值时，在回合中每步前及回合结束检查并自动 compact'),
					),
				);
			}
			slots.inject('conversation.input.right', () => slots.register({ name: 'conversation.input.right', id: 'dsh-auto-compact-ring', order: 10 }, Ring));
		}
		return { apply, inject };
	},
});
