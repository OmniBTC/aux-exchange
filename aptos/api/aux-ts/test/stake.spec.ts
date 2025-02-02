import { ApiError, AptosAccount } from "aptos";
import * as assert from "assert";
import { describe, it } from "mocha";
import { AuxClient } from "../src/client";
import { FakeCoin } from "../src/coin";
import { AuxEnv } from "../src/env";
import { AU, DU } from "../src/units";
import { StakePoolClient } from "../src/stake/client";
import type { StakePool } from "../src/stake/schema";
import BN from "bn.js";

describe("Stake Pool tests", function () {
  this.timeout(30000);

  const auxEnv = new AuxEnv();
  const auxClient = new AuxClient(
    auxEnv.aptosNetwork,
    auxEnv.aptosClient,
    auxEnv.faucetClient
  );
  const moduleAuthority = auxClient.moduleAuthority!;
  const sender = new AptosAccount();
  const senderAddr = sender.address().toShortString();
  let lastPoolUpdateTime = 0;
  let lastAccRewardPerShare = 0;
  let lastRewardRemaining = 0;
  let lastRewardAmount = 0;
  let lastEndTime = 0;
  auxClient.sender = sender;

  // STAKE COIN
  const auxCoin = `${auxClient.moduleAddress}::aux_coin::AuxCoin`;
  // REWARD COIN
  const usdcCoin = auxClient.getWrappedFakeCoinType(FakeCoin.USDC);

  let poolClient: StakePoolClient;
  let pool: StakePool;

  it("fundAccount", async function () {
    await auxClient.fundAccount({
      account: sender.address(),
      quantity: DU(1_000_000),
    });
  });

  it("createStakePoolClient", async function () {
    poolClient = new StakePoolClient(auxClient, {
      coinInfoReward: await auxClient.getCoinInfo(usdcCoin),
      coinInfoStake: await auxClient.getCoinInfo(auxCoin),
    });
  });

  it("mintAux", async function () {
    await auxClient.registerAuxCoin();
    let tx = await auxClient.mintAux(
      sender.address().toString(),
      AU(2_000_000_000_000),
      { sender: moduleAuthority }
    );

    assert.ok(tx.success, JSON.stringify(tx, undefined, "  "));
  });

  it("mintOther", async function () {
    let tx = await auxClient.registerAndMintFakeCoin(
      FakeCoin.USDC,
      AU(2_000_000_000_000)
    );
    assert.ok(tx.success, `${JSON.stringify(tx, undefined, "  ")}`);
  });

  it("createStakePool", async function () {
    const durationUs = 3600 * 24 * 1_000_000;
    const rewardAmount = DU(1_000_000);
    const createEvent = await poolClient.create({
      rewardAmount,
      durationUs,
    });
    assert.ok(createEvent.transaction.success);
    const event = createEvent.result;
    assert.ok(!!event);
    const poolId = event.poolId;
    pool = await poolClient.query(poolId);
    assert.equal(pool.accRewardPerShare, 0);
    assert.equal(pool.authority, senderAddr);
    assert.equal(
      pool.endTime.toNumber() - pool.startTime.toNumber(),
      durationUs
    );
    assert.equal(pool.rewardRemaining.toNumber(), rewardAmount.toNumber());
    assert.equal(event.stakeCoinType, pool.coinInfoStake.coinType);
    assert.equal(poolClient.coinInfoStake.coinType, event.stakeCoinType);
    assert.equal(
      pool.coinInfoReward.coinType,
      poolClient.coinInfoReward.coinType
    );
    assert.equal(event.rewardCoinType, pool.coinInfoReward.coinType);
  });

  it("deposit", async function () {
    const initStakeCoin = await auxClient.getCoinBalanceDecimals({
      account: sender.address(),
      coinType: pool.coinInfoStake.coinType,
    });
    const tx = await poolClient.deposit({
      amount: DU(500),
      poolId: pool.poolId,
    });
    assert.ok(tx.transaction.success, JSON.stringify(tx, undefined, "  "));
    const depositAu = DU(500)
      .toAtomicUnits(pool.coinInfoStake.decimals)
      .toNumber();
    const event = tx.result;
    assert.ok(!!event);
    assert.equal(event.depositAmount.toNumber(), depositAu);
    assert.equal(event.user, senderAddr);
    assert.equal(event.poolId, pool.poolId);
    assert.equal(event.userAmountStaked, depositAu);
    assert.equal(event.userRewardAmount, 0);

    pool = await poolClient.query(pool.poolId);
    assert.equal(pool.amountStaked.toNumber(), 500);
    const finalStakeCoin = await auxClient.getCoinBalanceDecimals({
      account: sender.address(),
      coinType: pool.coinInfoStake.coinType,
    });
    assert.equal(initStakeCoin.toNumber() - finalStakeCoin.toNumber(), 500);
    lastPoolUpdateTime = pool.lastUpdateTime.toNumber();
    lastAccRewardPerShare = pool.accRewardPerShare.toNumber();
    lastRewardRemaining = pool.rewardRemaining
      .toAtomicUnits(pool.coinInfoReward.decimals)
      .toNumber();
  });

  it("claim", async function () {
    const initRewardBalance = await auxClient.getCoinBalance({
      account: sender.address(),
      coinType: pool.coinInfoReward.coinType,
    });
    console.log("Sleeping for 2 seconds");
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await poolClient.claim(pool.poolId);
    assert.ok(tx.transaction.success);
    const event = tx.result;
    assert.ok(!!event);
    pool = await poolClient.query(pool.poolId);
    assert.equal(
      event.accRewardPerShare.toNumber(),
      pool.accRewardPerShare.toNumber()
    );
    assert.equal(
      event.rewardRemaining.toNumber(),
      pool.rewardRemaining
        .toAtomicUnits(poolClient.coinInfoReward.decimals)
        .toNumber()
    );
    assert.equal(
      event.totalAmountStaked.toNumber(),
      pool.amountStaked
        .toAtomicUnits(poolClient.coinInfoStake.decimals)
        .toNumber()
    );
    const duration = pool.lastUpdateTime.toNumber() - lastPoolUpdateTime;
    const durationReward = Math.floor(
      (duration * lastRewardRemaining) /
        (pool.endTime.toNumber() - lastPoolUpdateTime)
    );
    const stakeAu = DU(500)
      .toAtomicUnits(pool.coinInfoStake.decimals)
      .toNumber();
    const accRewardPerShare = Math.floor((durationReward * 1e12) / stakeAu);
    assert.equal(
      pool.accRewardPerShare.toNumber() - lastAccRewardPerShare,
      accRewardPerShare
    );
    const finalRewardBalance = await auxClient.getCoinBalance({
      account: sender.address(),
      coinType: pool.coinInfoReward.coinType,
    });
    const expectedReward = Math.floor((accRewardPerShare * stakeAu) / 1e12);
    assert.equal(event.userRewardAmount.toNumber(), expectedReward);
    assert.equal(
      finalRewardBalance.toNumber() - initRewardBalance.toNumber(),
      expectedReward
    );
    lastRewardRemaining = pool.rewardRemaining.toNumber();
    lastRewardAmount = pool.amountReward.toNumber();
    lastEndTime = pool.endTime.toNumber();
  });

  it("modifyPool", async function () {
    const rewardAmount = DU(1000);
    const timeAmount = new BN(1_000_000 * 3600 * 24);
    const modifyPoolResult = await poolClient.modifyPool({
      poolId: pool.poolId,
      rewardAmount,
      rewardIncrease: true,
      timeAmount,
      timeIncrease: true,
    });
    assert.ok(modifyPoolResult.transaction.success);
    const event = modifyPoolResult.result;
    assert.ok(!!event);
    pool = await poolClient.query(pool.poolId);

    assert.equal(
      pool.amountReward.toNumber(),
      lastRewardAmount + rewardAmount.toNumber()
    );
    assert.equal(
      event.rewardRemaining.toNumber(),
      pool.rewardRemaining
        .toAtomicUnits(poolClient.coinInfoReward.decimals)
        .toNumber()
    );
    assert.equal(pool.endTime, lastEndTime + timeAmount.toNumber());
    assert.equal(event.endTimeUs.toNumber(), pool.endTime.toNumber());
  });

  it("modifyAuthority", async function () {
    const tx = await poolClient.modifyAuthority({
      poolId: pool.poolId,
      newAuthority: moduleAuthority.address().toShortString(),
    });
    assert.ok(tx.transaction.success);
    const event = tx.result;
    assert.ok(!!event);
    assert.equal(event.authority, moduleAuthority.address().toShortString());
    pool = await poolClient.query(pool.poolId);
    assert.equal(pool.authority, event.authority);

    // Try to modify authority again (sender == sender, so this will fail)
    const tx2 = await poolClient.modifyAuthority({
      poolId: pool.poolId,
      newAuthority: senderAddr,
    });
    assert.ok(!tx2.transaction.success);

    const tx3 = await poolClient.modifyAuthority(
      {
        poolId: pool.poolId,
        newAuthority: senderAddr,
      },
      { sender: moduleAuthority }
    );
    assert.ok(tx3.transaction.success);
    const event2 = tx3.result;
    assert.ok(!!event2);
    assert.equal(event2.authority, senderAddr);
    pool = await poolClient.query(pool.poolId);
    assert.equal(pool.authority, event2.authority);
  });

  it("endRewardEarly", async function () {
    // end the reward early and claim all remaining reward
    const tx = await poolClient.endRewardEarly(pool.poolId);
    assert.ok(tx.transaction.success);
    const event = tx.result;
    assert.ok(!!event);
    const tx2 = await poolClient.claim(pool.poolId);
    assert.ok(tx2.transaction.success);
    pool = await poolClient.query(pool.poolId);

    assert.equal(event.endTimeUs.toNumber(), pool.endTime.toNumber());
    assert.equal(event.rewardRemaining.toNumber(), 0);

    assert.equal(pool.amountReward.toNumber(), 0);
    assert.equal(pool.rewardRemaining.toNumber(), 0);
    assert.equal(pool.endTime.toNumber(), pool.lastUpdateTime.toNumber());
    assert.equal(pool.amountStaked.toNumber(), 500);
  });

  it("withdraw", async function () {
    const initStakeBalance = await auxClient.getCoinBalance({
      account: sender.address(),
      coinType: pool.coinInfoStake.coinType,
    });
    const tx = await poolClient.withdraw({
      poolId: pool.poolId,
      amount: DU(500),
    });

    assert.ok(tx.transaction.success);
    const event = tx.result;
    assert.ok(!!event);

    assert.equal(event.user, senderAddr);
    // User should not receive any reward since they claimed after the reward ended
    assert.equal(event.userRewardAmount.toNumber(), 0);
    const stakeAu = DU(500)
      .toAtomicUnits(pool.coinInfoStake.decimals)
      .toNumber();
    assert.equal(event.withdrawAmount.toNumber(), stakeAu);
    const finalStakeBalance = await auxClient.getCoinBalance({
      account: sender.address(),
      coinType: pool.coinInfoStake.coinType,
    });
    assert.equal(
      finalStakeBalance.toNumber() - initStakeBalance.toNumber(),
      stakeAu
    );
  });

  it("deleteEmptyPool", async function () {
    const tx = await poolClient.deleteEmptyPool(pool.poolId);
    assert.ok(tx.success);
    let threw = false;
    try {
      await poolClient.query(pool.poolId);
    } catch (e) {
      assert.equal((e as ApiError).errorCode, "table_item_not_found");
      threw = true;
    }
    assert.ok(threw);
  });
});
