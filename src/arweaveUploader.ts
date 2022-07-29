import config from 'config';
import base64url from 'base64url';
import { ConsumeMessage } from 'amqplib';
import { getContent } from './utils/getContent';
import { queueBroker, QueueInfo } from './utils/queueBroker';
import { log } from './utils/logger';
import { safeStringify } from './utils/safeStringify';
import { getObject } from './utils/s3Downloader';
import {
  broadcastTx,
  bundleAndSignBundleData,
  createBundleData,
  getBalance,
  getPrice,
  reBundleData,
} from './arweaveTransport';
import { hashFn } from './utils/hashFn';
import {
  VERIFY_BUNDLED_TX,
  VERIFY_CHUNK_ID,
  VERIFY_CHUNK_ID_LONG,
} from './utils/queueNames';
import { fromMinutesToMilliseconds } from './utils/fromMinutesToMilliseconds';
import {
  addItem,
  getAllMemPoolItems,
  // getItemsAge,
  itemsPoolLength,
} from './arweaveTransport/itemsMemPool';

const BUNDLE_SIZE = config.get('arweave_uploader.max_concurrency') as number;
const VERIFY_BUNDLED_TX_INTERVAL = config.get(
  'arweave_uploader.verify_bundled_tx_interval'
) as number;
const VERIFY_BUNDLED_CHUNK_IDS_INTERVAL = config.get(
  'arweave_uploader.verify_bundled_chunk_ids_interval'
) as number;

async function bundleItems(queueInfo) {
  if (itemsPoolLength() > 0) {
    let bundleTxId;
    const items = Object.entries(getAllMemPoolItems()).map(
      ([chunkId, content]: [string, any]) => ({ chunkId, ...content })
    );
    const dataItems = items.map((item: any) => {
      return item.signedDataItem;
    });
    const totalBundleSize = items.reduce((prev, { contentLength }) => {
      return prev + contentLength;
    }, 0);
    const chunkIds = items.map((item: any) => {
      return item.chunkId;
    });
    const fields = items.map((item) => item.fields);
    const signatures = items.map((item) => item.signedDataItem.signature);
    try {
      log.info(`Creating bundle for ${chunkIds.length} chunkIds`);
      const transaction = await bundleAndSignBundleData(dataItems);
      bundleTxId = transaction.id;
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        {
          txid: bundleTxId,
          createdAt: Date.now(),
          chunkIds,
          signatures,
          fields,
        },
        {
          ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_TX_INTERVAL),
        }
      );
      items.forEach(async (item: any) => {
        const { channel, msg, content } = item;
        await queueBroker.sendDelayedMessage(
          VERIFY_CHUNK_ID_LONG,
          { ...content, createdAt: Date.now() },
          {
            ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_CHUNK_IDS_INTERVAL),
          }
        );
        channel.ack(msg);
      });
      await broadcastTx(transaction);
    } catch (error: any) {
      console.log({ error });
      if (
        error?.message.includes('Nodes rejected the TX headers') &&
        totalBundleSize
      ) {
        const balance = await getBalance();
        const price = await getPrice(totalBundleSize);
        if (balance.winston - price < 0) {
          log.fatal(
            `Not enough funds to upload bundle with id ${bundleTxId}. Will pause worker until new funds are loaded`
          );
          queueBroker.pause(queueInfo, {
            healthCheckFunc: async () => {
              try {
                const currentBalance = await getBalance();
                const currentPrice = await getPrice(totalBundleSize);
                if (currentBalance.winston - currentPrice > 0) {
                  log.info(
                    `Healthcheck has succeed for queue ${queueInfo.subscription?.name}. New funds has been loaded. Will resume worker.`
                  );
                  queueBroker.resume(queueInfo);
                  return true;
                }
                log.fatal(
                  `Healthcheck to check balance has failed because funds are not enough yet. Current balance is ${currentBalance.ar}ar`
                );
                return false;
              } catch (healthCheckError: any) {
                log.error(
                  `Healthcheck to check balance has failed due to error: ${safeStringify(
                    healthCheckError
                  )}`
                );
                return false;
              }
            },
            healthCheckInterval: config.get(
              'arweave_uploader.health_check_interval'
            ),
          });
        }
        items.forEach(async (item: any) => {
          const { channel, msg } = item;
          channel.nack(msg!, true);
        });
      }
      log.error(
        `Failed to upload bundle to arweave due to error: ${safeStringify(
          error?.message || error
        )} for : ${bundleTxId}`
      );
      items.forEach(async (item: any) => {
        const { channel, msg, content } = item;
        await queueBroker.sendDelayedMessage(VERIFY_CHUNK_ID, content, {
          ttl: fromMinutesToMilliseconds(
            config.get('arweave_uploader.requeue_after_error_time')
          ),
        });
        return channel.ack(msg!);
      });
    }
  }
}

export function arweaveUploaderFactory(queueInfo: QueueInfo) {
  const { channel } = queueInfo;
  return async function arweaveUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { chunkId, fields } = content;
    try {
      const file = await getObject(chunkId);
      const contentLength = file.ContentLength;
      const calculatedChunkId = hashFn(file.Body as Buffer).toString('hex');
      if (calculatedChunkId !== chunkId) {
        log.fatal(
          `Integrity fail for ${chunkId}, actual chunkId is ${calculatedChunkId}. It could happen because of legacy files using a different kind of id`
        );
        return channel.ack(msg!);
      }
      const signedDataItem = await createBundleData(file.Body, fields);
      addItem(chunkId, {
        signedDataItem,
        channel,
        msg,
        content,
        contentLength,
        fields,
      });
      if (
        itemsPoolLength() >= BUNDLE_SIZE
        // getItemsAge() > fromMinutesToMilliseconds(5)
      ) {
        await bundleItems(queueInfo);
      }
      return;
    } catch (error: any) {
      if (error?.code === 'NoSuchKey') {
        log.fatal(`ChunkId not found in S3 ${chunkId} message will be ack`);
        return channel.ack(msg!);
      }
      log.fatal(
        `Unexpected error for ${chunkId} message will be reenque for verifyChunkId`
      );
      await queueBroker.sendDelayedMessage(VERIFY_CHUNK_ID, content, {
        ttl: fromMinutesToMilliseconds(
          config.get('arweave_uploader.requeue_after_error_time')
        ),
      });
      return channel.ack(msg!);
    }
  };
}

export function arweaveReUploaderFactory(queueInfo: any) {
  const { channel } = queueInfo;
  return async function arweaveReUploader(msg: ConsumeMessage | null) {
    const content = getContent(msg!.content);
    const { txid, chunkIds, signatures, fields } = content;
    try {
      const dataItems = await Promise.all(
        chunkIds.map(async (chunkId, ix) => {
          const file = await getObject(chunkId);
          const dataItem = await createBundleData(file.Body, fields[ix], false);
          dataItem.getRaw().set(base64url.toBuffer(signatures[ix]), 2);

          // dataItem id getter gets the signature from the binary
          // dataItem id setter sets the value of _id that is used internally
          // so after modifying the signature we need to set the _id by calling the setter
          // with the value given by the getter
          // eslint-disable-next-line no-self-assign
          dataItem.id = dataItem.id;
          return dataItem;
        })
      );
      const bundle = await reBundleData(dataItems);
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        { ...content, createdAt: Date.now() },
        {
          ttl: fromMinutesToMilliseconds(VERIFY_BUNDLED_TX_INTERVAL),
        }
      );
      await broadcastTx(txid, bundle.getRaw());
      log.info(`Bundle was re-uploaded for txid: ${txid}`);
      channel.ack(msg);
    } catch (e) {
      console.log({ e });
      log.error(
        `There was an error when trying to reupload txid ${txid}. Will verify again`
      );
      await queueBroker.sendDelayedMessage(
        VERIFY_BUNDLED_TX,
        { ...content, createdAt: Date.now() },
        {
          ttl: 0,
        }
      );
      channel.ack(msg);
    }
  };
}

// export async function enqueueTxToVerify() {
//   await queueBroker.sendDelayedMessage(
//     VERIFY_BUNDLED_TX,
//     {
//       txid: '3eJ9I4DglzcRcooc0UGMUDql6oAakh8cHvnKjRulAfo',
//       createdAt: Date.now(),
//       chunkIds: [
//         'c2cfe318ecfcf4d02391b1734a259e2dfa15aa43b3b64d4d0e6a13686f3fc70c',
//         'c30e825ab5e1c93706aabfb8d3fa56e738d5ff42caf96dfe2dd15df546572f3a',
//         'c346b545a31e7ee991aa08fed32a1c60b1b21bf6e79d5644766de3407a522772',
//         'c34b3be921f1d81066db4354307a4afe8dff8f90d53531d49b0a47853e64539b',
//         'c34353797ddc56a439c3278e71bf9dac8bf0da63172eb159ada97eec94d9487f',
//         'c33336e3539d796a30eb37c72fa979717922e33d21ce6101512c67f608979f81',
//         'c3441bfe0c9be3794dda28bbc5fa05b2c39348ae004decb52d66b4c6f09d72fe',
//         'c2f4ea98dd143d6a060bc37212cb79a5e7313b75706a5cfcc8aceab2d3ca2b48',
//         'c33a07b82be67e3fa4e20efba715ef28baa649c2c27001ed5b3406dba05e8c89',
//         'c3290eae8fd9d7564d634b6e7b3ecaf7b2738cd67a70d48eb2907b832783f96a',
//       ],
//       signatures: [
//         'ab1cOJYEKUaz3I1OtzbI6yGPiOtYz4UgOTxZ7fsVBCHrTE0Fsev46UoRJM9xwtk3wx00RPW5hmO3k1MsDm0z82kf_C4FCmftHWDwuC4hLs90s_RvmBezJs6VqzEmjB4L64clYc3XXEb95b0AFxXJ3NYUxBx462SPNwfHpuGTkqsR5iijMxfb-NqN7-mBb2ubSATBrIKvk0SY1hGCLLhCe2vHsp8d5ldZuMZGg45kgXbT6jOpjEZIqlVe9t6MXRh37SmLmdbYR85sVY2obZfao_9OazHQ4hTtRU_H9YFStvv5f1jQLl0ro7rhxgQyxh3bcQrHdZ1ZIock30CX0erl7IxQ7GtDANb4shXuQ43u6ofKl1Lm7yn4nIf_6JfjFd4JffrK6S-3Klzz5mPwU3TOv-O04yMYk60oY6XCYWZvd3l4uvZR4IO4GifjLXHOAeBvu5iyOT_-7zqQFpd-cmXMqra0BScFF747_bKwKG_1B_wOk1XFy8A4AOgYeoO5Ni_jvSCIMxqqAbOOmm4dKB61p0uD2ZCCUYNVEAnmUT0XkPJwuOZjugC85VBaE8su5uyYQSLtJ0dM5KZkIU-8QTogiZ7FKR5qRCFhyXepIwrkHnISqHXtO1esRbnC0cimo0W6GAco44pitHIBih0ShFuO9VCYQYak87vV_sMklZCq1gc',
//         'tqUR3WXDR8b2Uy7EmqD0A3rau8fBLGuNH5u3nyB8q6Hxpnp7M8txC7T0SE6xhEUGWr5AaA04sXDQ6hR9Dt1TvhvaMlmgOaKmF6qqYp_HIyZx1N9SAxcpwIz0JzkfPH7ibnEgt-VVQMIjpMiJGAEvy07_rSpQKtDKf7bfZPTgldLoy9rtg9hdASLafm35OHnceD1L9YdXLvkmSIhUI0_g_3XncmzT8rit3VXWQy77PKonAE1KZ1MyhgT-Aj2E7s-KZlQSLWH-k46675gochMWMoCWMtPVTCM_GusKudEkmltXoEMforwE6GNvkcpdSkbtJuskOdGH0MNr41OiriVZM1USNU5SPIm2-wdxsnViQTM0niSpUQ5VGrIWSeLVJup4hf4JFCyENiEkZovhk1iMHEEbOTdX1GltuZilw8zrhSTWrKuEE-7w3O0eySEUrRhYFltdCoaNxeOsQkEdNHAmnu0EFNyGVn3qJ_w4PpNtyk1fgYNDrK6VU6Jn3MwOTDbr0EVpWmiMhaSmlRyyQ_H2G_b3_0ZdXm5Lv20EHKc1encyvDvG7CxXo6tb5blkahm4fruJUm6MQ8pgHCP3cNFv75tXQgDh8nvrNJb69K4YPiFEGhDSIY1AdDCpi9ZX1WZNKFDaSwKn6StmXe8JHcPh7IXwaQ7y0gqCLYeY5K4GIZI',
//         'OJqxq6C6-rb9Op0II7WeZc83T_TVaU4m8EmDmAtxAFGT3uIuA8VW66LRDnTVv1quxStE9gCQQZJ4J1Xznv1fqfXTYnkLaAjqAHo8JklvK0N5DGxWpe2s_HXIFV5EpIMkQw6TCli9dJKw6CUHkI1cspmvvOISFKLeHxqWEMMU2S6tmO2klOMkVNaLVXu6q_coimW8bSM-nRvYjGhIraVQXjOAsmSFt9ztT40BfAvAWra1M1Vsir6cUMwVr59lUPNi60fyzEoz9bozHVnhgWKyt-x2AdxRIR4t8S0DiP_1cR61N-cr9ceWES1RgfuqgpHnPiY80bJtL8nLgkwY2C7i0lgJ3HQLwqxstTdhKUWR6_ZA4lopc3_slrfj5MLhNvA65IKlCP-sbbOPHOAtTzif1Xp90kXyLXyIP6vm1PalkHvD4b6IY_45n5sjjUMwF_5KJOnVuyw1qHadAfjNFZnX9XC_xEPfhxLdfb0T07uy0hbJjmy-dC-mjcPL5sT3z5rG6lwsPDfxE9vEcloW18Kbu2ZUnZ-o66w0aGTYjgVvoHNhZL4SQZlZe935otvOAdU0xJCSV2UL1UGuR0xG7GGDGWcDN9PQ6n4VYaAYHf69vg_yB_BcPacjLTmQtMRn9I_30VyMKNlj2kSs2h9_cz5JvTJ9Uor0dpz_g0RjrEYmdTg',
//         'b16hP-dR6iv8TV4bjTuYBPfTyOW_PS8yti0nmPcSByWdG_I4DhgcJBi7cWbVePGD6aWHEuMT1dHIOGQwA-dSF1iTiTPmpw3rFsRzEditabCCmP8GVfRaHBfAaGgqCftUk2a_Y3mTb_MFLBPy5L8EgWPkjOOdVg-IOQ3xw8T3dVkTyNGT67Wek_EHi01fn1ZNpdXi-NS7BSzEZS4B9WJLAUBljWCWvljdh7UOzeBqA1eIAFAIyj9lukaZgBB1Vh8VP0p11gsk9ZwEyFv-Rbo5-4ks6dj0P8X2iFc_MHuMIJLJ0ZlRBfZIZLH0NVAV-gyjltkLWeW3tM6_SdMUqL9R5ne3IFAHK4hgUDltuCulnyPt-XkAW-Jvk2d_R4jV4EaM1IhvZ4k5ozGZegq99kbj9wEm7zJ3_sLmJ9BJTOh0rQWvwkPV7-G0xIvTOTejwNDtjlWY59SwU5En7jLee0pZWDu95b3ImUHGfOhRE-9YMPz25G_T9eHxY2MkBRoZxA91JuvLOaqpePOynSl3xlBRYuqvJpWAXGtKDPvdbmXx662jkaYFmiHe4J8v3LJMSlfajCvJS8rfhBqyrRiVJkExtHxsyJL3G-IQBwHb6V-gM_MVAP_XKpB3MLIq7hR-GEWdwpsfx9429nam2SV39X_5BSRogyeHSoEgbEcY62i1edc',
//         'ufsUF7uaMkrC4ca4_-uGTA0Y5BaJFAtF0ashASy1VJS2PDry_hdDYapL67RKX4tJpZLHy4AhcG-ottmOgcQfBbr9oMyZeSNiBUKLRmtp0Mi4Tu_kJ2ULt7yhi-6lPolvZZ_gkVIjGZssd5wjQuBr7YUf0_0NabljpjKEdYuuxT-Vab94ce4HCihl1Hs__R2Pg2uP59o7sj9hyecPCrizTkxtwPb1hMMWJ_zhAnd7pMqGNKib76PDsAcq6ZgkSrQjKZbmIn7NoM73xaiw7JkMWfWjc5s0OLh8ErMuiMttt-8R_CfOdKP6qOE6rYocsL6m6rAJh6283pP1jvMATKaLUARvsKHjRn2QsJ5HgbxIeFkHeb--pa2FSzE_qm7zhE8MA8pvqJ17Wrr_ytRTxRcIPqWNSooatlEx8SctjESK0xnZq16Oehv5ElUos4g3PvpqOtWiS_EYMNUHKViTejIyDKnCzNXGONs6sxU4oGm8shcqPHWFM4sNf09NO-plAbSo1Bxfk-GYDZsR0HcDFdaqJbUo1j9pPiP8Tcof_gcWXYiNz291dS6nSSEnNj5a2ZvFiY_ee7_g5cU26HekpCjx-ffsJTWc9MgIIJkIywklN79NZFf71QN-2nD23_e40bfgHq-J2xxTJ4qVI6Sr2a8QRAb857s7tyG25bcI6T4Kqbo',
//         'L89OL2ScD-GlSAdVSWX6sYtG38GISuZWZrMf9aFLGpU0doIPBFNfZsGbgwnM2amSmOidHB6e3od60xSyYIhPKEAxfvobI_b8tOzhamXQvjUvw2Bwue-6owMqIX_U5VOsffbWjRsWd_NhgFtLf11aa112YoBmqwWTobNFGm3KYTSzw30xraj_kAziFPkMnf5uJh2oBVknUhqECn8mKwW_LoI2d2gvfH8si_dGvmLiYGbd-22NXyXZL_AoPe6-ZzNGzKKt_YlM45eBGt3U1Cc93LfwLTCCNCFrFjH7Re1vou06AzC3VH_TjYrs9dbyT-JxRmx-c_eVlW9lp5EwFAWWSDUd3fQeZluF6SyejPfc8Q84nX-i_IbYkCg4EH_HvDnfv8xRzvEMZYWmIJGzNrUzhlz26mRR_mULg9DH8v2oO8LYu9KIxKG8F0Bbd-V94QefeDWmsuc9nmN6WdYH8ytR-y4XSeHDmds90xvYZrK_I6kUbkQCGfsD8oMZUsqHiykLI8VGfBZV6a2zBrzOtEC-IjBlxGiJJu-yfgihVUVRWWRzdfp5ra_bcHM0xDTRNMUv4zpOPv77uIE9FvelQhJ_5quapZlsLwS3r2UWLCMvlRMzVBuXTyy0JikjJJfd1WsN7c2l3Xu43PMYfcG6hBa31cOWu9UwC-WrbQNWtlvmchM',
//         'hlc3yxCS9CT_wvYwGW8LTvcNzI594Z4EC2h4lEvqD3-de19dptIJbBT1so-LNMlVwfOXsFp56vUneFGEKOwx_khr0vV41B1fvuyuGT6Jdv-Y6wiyktWUyFdh8SZceyuph_aO_BG4E6K8Gks6LKPAA-Sm41qFi2ArJULqW6wyydBMUj40UpyOB5SLmpf73hywHDkqMsfNJ5v2A0-drb6mX6KWSoIVywnZzCc1GgFztqTVevVGGbQh8b7U0FZPdCsxUEtLb4oCs-gdah5R1wX3RMSVd57leNVz44N4id9rDhxCPEEghz9K1_iiytr9T5NwR0g_imFzOFiBOqBIQDnvof6J6ybuDazzNekSA3FRUdb_boLPSBFRtDU-bQyOVMd4Pt_CpVKIzSWAwVmHw1GV1Fteehc2p3NaxzL4nU6dX_BW0okepdl4l81mR-QhXk9qZtLTbBm7GRcbqiKPugEfY937nE47ybuLjtOp3FND36As7SHn4TxcuX4_vaPDjRhP-IcKqQ-HfkATfB9LjNR-MKc6BQCbsgD15dYf6aUE0SCqOJ74MYafC7eqUfjcOV4mTJTH2b4ehBWC-T6wsYGUAga23TS2v2tcv-7ELNpslKjnlZUmpuXXXivQVDf32pIfUGm0qtQdaBX4ATAo6h8aHW0JinJxeWGXLWW7irRcAYg',
//         'AIrz8UO48ubKYP6270PN0Nh-fVeradGM4tDILlYaTEmhefQWm9MM2c9E37QUJTPSX34D3wWeywq5jnexO1fnCJmUkKj1OdemfO8Ppz1Rw9SgYR-J9KyH7wGZeEdLQzom56nnz_Kirao3AU1FL3xCeMyvNt58kXxzH_LYsmXWIOkXTVG-5HtHvcUuDjtYQtBivUVpJbSpwr4LxZ-cQhtTQnzVjKXR11O21LhuWofMpHKKCurQy_VmyatjdE0hR29B56Yz-6E62PIIY-1JZGY9d57yhGjoDtu-M714x63Fy6uMzUb9a00T75lOiVwdqXe0ossozZSi0jbGlqMDN21RF3vWj9sCb5kSId-fUIhJmO54VCo3xV4KUpiszDrjaQG9E7S9DCLGB8poWEK8QDreSH-ZseVNY5pvJEsMl4GMZLn9OcR2sprGH47Yo9xacnTUaCyp9xBmauIBUJ2oIHY-9m-JiLZHomJ8tvBHj-3BjY3U1MfRjvlQYN2bF0cOp81jXmMh2Xa-69dY2o117JlRQTkpUmQ5ozSmkTjQeQFRbeN7zzsOxU1NWGMHgPQjBtN9lyKFB0vOUMD1g6tFybbk4jKHhX_ucs3eNb8CEJx0kPs-PL3KOw371li67fbLSsIAZpvEh9c1HVgNcgInGVRRbz3f5S-_NxW-D16PxS6J2QE',
//         'FWwa2zVPKzmS2spVE9yJTP8K3hXoCRweu4spirIMrOi-UAFp-iOCoa-G597WZ5wU0zDG31iQ9CUUjd35P42380q-HSwI3unGecVEtUvnKUiDo1bbmrR_nsu1hmRbduxlQarwYCtsZt-3C6Yg3VZ25h1nZ9mmTsz4642nbqh7CUT314M4sxaCXHQHnrlw19HJkDj6rY1hRgRhqSPV5Eq3WsLDKcnlmQ89-FOCPN8VpnKmtFGi2vAnkMnu9enwVpRMoHdjhcty1rSZNSM4j8AMKO-xuc_33YqtGXVHXcJcacXpdoLomDx9UEAz-y-lYHR5EwY5Ulml_B6QSM6E-fb8K14a4Q2dLd06u2GpPVnMw6HqTiox6CdnCRv78si3GBkA1kmj56dGgq-MeC__1AEviPu0mseDLHCmH4_U8YklrXN-o01feeYi8sBUexIShl2M_bm1ODdGtMX6ai28Ih9LfPTzUJoAsasO4EOeNClHwxUH2TFXa0B_y0V-EuyyAqDpgpmULvXG4K73TjjZPUecgiahz90Ij6BuTITpYWcXBXWIuyjHTZb2A1V0K1YdLnUuqu34T4VzUv_g1y_ZgIkzXbBfWPuXKHFwVnsGOehNshmgirO2tXBTezj44vJFxvql13dNHe2vfVh5c2fKz7yoToebcLQkxGQeri4GWKQJxaI',
//         'Q16i0YtRWHeqIf195IvdKiqlDr8lgN5ht71qgd1foAiypujvlrAat8WOc6BBAE2o-Xq4ANpkHYmgiH27NRd1LrUxDKfVIWHe5AvVbuW-eBhc-mHfPxdzC4CR_R2A_jwcWDC5F3-y9uYEx8lJ7sACSGz_Mv3v3jSE73MoQzEju_74wTmG-vfAEbppiSKNiheH5uKzBwmlFCM4UKkyw3yyyTutYJR8bIdhwLNGTqCu_tSJXWmisqRV8VfdGx9dNzkxWifUrcXeOUiDdBEwpi7gbHm579tAYye076BmHrI00d5-rVo8xbN8mY9p1vB1pdDecDYTVqmok4OzCoS7t37dAZZs3821E9iHqwo8pgorT2Mg1AlMzor-s6oNj9lzp4AUizTGWpn8Tc1K91nfvtAkzR_Ac2WZd42XnBHaESDab_gKi2ochgu5REXwcEdl4gNA_Zy0B8E4tIePEuZr6dxjp_rBEgIh5THx23fNTRas0-29xQWBkq3FtFiWB9rAqDyxbIlHKg0HAbw2wXMQn9UKXsF1vG_BeuIqzpQQqa98LAPZRfG1Nqq1_YfooPeuJsO14lfzlFR7AIXrFVezBnvFIiP9SyqDCZT0EtUhXFUea1frCe8tSVi9j0UxdMSr6PgJyHcccM7y4Vorw7Zm_t91DPNF5KQwOceybh1E7av_r2I',
//       ],
//     },
//     {
//       ttl: 0,
//     }
//   );
// }
// enqueueTxToVerify();
