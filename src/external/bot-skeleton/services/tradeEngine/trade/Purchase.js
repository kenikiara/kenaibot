import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log, notify } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            if (this.multipleTradesEnabled && this.multipleTradesCount > 1) {
                return this.purchaseMultipleTrades(contract_type);
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        // Armed by the "Execute N identical trades" block for the next purchase only.
        setMultipleTradesInfo(count) {
            this.multipleTradesCount = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
            this.multipleTradesEnabled = true;
        }

        // Buys the same contract several times at once. The first accepted buy drives the
        // strategy (after-purchase result, martingale); the rest are reported and totalled.
        purchaseMultipleTrades(contract_type) {
            const total_trades = this.multipleTradesCount;
            this.multipleTradesEnabled = false;
            this.multipleTradesCount = 1;

            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            return new Promise((resolve, reject) => {
                let has_primary = false;
                let settled = 0;
                let failed = 0;

                const onSettled = () => {
                    settled += 1;
                    if (settled === total_trades && failed > 0 && has_primary) {
                        notify('warn', `${failed} of ${total_trades} identical trades were not accepted`);
                    }
                };

                const onBought = response => {
                    const { buy } = response;

                    contractStatus({
                        id: 'contract.purchase_received',
                        data: buy.transaction_id,
                        buy,
                    });
                    log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                    info({
                        accountID: this.accountInfo.loginid,
                        totalRuns: this.updateAndReturnTotalRuns(),
                        transaction_ids: { buy: buy.transaction_id },
                        contract_type,
                        buy_price: buy.buy_price,
                    });

                    if (has_primary) {
                        this.trackExtraContract(buy.contract_id);
                    } else {
                        has_primary = true;
                        this.contractId = buy.contract_id;
                        this.store.dispatch(purchaseSuccessful());

                        if (this.is_proposal_subscription_required) {
                            this.renewProposalsOnPurchase();
                        }

                        delayIndex = 0;
                        resolve();
                    }
                    onSettled();
                };

                const onFailed = error => {
                    failed += 1;
                    onSettled();
                    if (failed === total_trades) {
                        reject(error);
                    }
                };

                for (let i = 0; i < total_trades; i++) {
                    doUntilDone(() => api_base.api.send(trade_option)).then(onBought, onFailed);
                }
            });
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
