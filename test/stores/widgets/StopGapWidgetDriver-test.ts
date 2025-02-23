/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { mocked, MockedObject } from "jest-mock";
import { ClientEvent, ITurnServer as IClientTurnServer, MatrixClient } from "matrix-js-sdk/src/client";
import { DeviceInfo } from "matrix-js-sdk/src/crypto/deviceinfo";
import { Direction, MatrixEvent } from "matrix-js-sdk/src/matrix";
import { ITurnServer, Widget, WidgetDriver, WidgetKind } from "matrix-widget-api";

import { MatrixClientPeg } from "../../../src/MatrixClientPeg";
import { RoomViewStore } from "../../../src/stores/RoomViewStore";
import { StopGapWidgetDriver } from "../../../src/stores/widgets/StopGapWidgetDriver";
import { stubClient } from "../../test-utils";

describe("StopGapWidgetDriver", () => {
    let client: MockedObject<MatrixClient>;
    let driver: WidgetDriver;

    beforeEach(() => {
        stubClient();
        client = mocked(MatrixClientPeg.get());

        driver = new StopGapWidgetDriver(
            [],
            new Widget({
                id: "test",
                creatorUserId: "@alice:example.org",
                type: "example",
                url: "https://example.org",
            }),
            WidgetKind.Room,
        );
    });

    describe("sendToDevice", () => {
        const contentMap = {
            "@alice:example.org": {
                "*": {
                    hello: "alice",
                },
            },
            "@bob:example.org": {
                "bobDesktop": {
                    hello: "bob",
                },
            },
        };

        it("sends unencrypted messages", async () => {
            await driver.sendToDevice("org.example.foo", false, contentMap);
            expect(client.queueToDevice.mock.calls).toMatchSnapshot();
        });

        it("sends encrypted messages", async () => {
            const aliceWeb = new DeviceInfo("aliceWeb");
            const aliceMobile = new DeviceInfo("aliceMobile");
            const bobDesktop = new DeviceInfo("bobDesktop");

            mocked(client.crypto.deviceList).downloadKeys.mockResolvedValue({
                "@alice:example.org": { aliceWeb, aliceMobile },
                "@bob:example.org": { bobDesktop },
            });

            await driver.sendToDevice("org.example.foo", true, contentMap);
            expect(client.encryptAndSendToDevices.mock.calls).toMatchSnapshot();
        });
    });

    describe("getTurnServers", () => {
        it("stops if VoIP isn't supported", async () => {
            jest.spyOn(client, "pollingTurnServers", "get").mockReturnValue(false);
            const servers = driver.getTurnServers();
            expect(await servers.next()).toEqual({ value: undefined, done: true });
        });

        it("stops if the homeserver provides no TURN servers", async () => {
            const servers = driver.getTurnServers();
            expect(await servers.next()).toEqual({ value: undefined, done: true });
        });

        it("gets TURN servers", async () => {
            const server1: ITurnServer = {
                uris: [
                    "turn:turn.example.com:3478?transport=udp",
                    "turn:10.20.30.40:3478?transport=tcp",
                    "turns:10.20.30.40:443?transport=tcp",
                ],
                username: "1443779631:@user:example.com",
                password: "JlKfBy1QwLrO20385QyAtEyIv0=",
            };
            const server2: ITurnServer = {
                uris: [
                    "turn:turn.example.com:3478?transport=udp",
                    "turn:10.20.30.40:3478?transport=tcp",
                    "turns:10.20.30.40:443?transport=tcp",
                ],
                username: "1448999322:@user:example.com",
                password: "hunter2",
            };
            const clientServer1: IClientTurnServer = {
                urls: server1.uris,
                username: server1.username,
                credential: server1.password,
            };
            const clientServer2: IClientTurnServer = {
                urls: server2.uris,
                username: server2.username,
                credential: server2.password,
            };

            client.getTurnServers.mockReturnValue([clientServer1]);
            const servers = driver.getTurnServers();
            expect(await servers.next()).toEqual({ value: server1, done: false });

            const nextServer = servers.next();
            client.getTurnServers.mockReturnValue([clientServer2]);
            client.emit(ClientEvent.TurnServers, [clientServer2]);
            expect(await nextServer).toEqual({ value: server2, done: false });

            await servers.return(undefined);
        });
    });

    describe("readEventRelations", () => {
        it('reads related events from the current room', async () => {
            jest.spyOn(RoomViewStore.instance, 'getRoomId').mockReturnValue('!this-room-id');

            client.relations.mockResolvedValue({
                originalEvent: new MatrixEvent(),
                events: [],
            });

            await expect(driver.readEventRelations('$event')).resolves.toEqual({
                originalEvent: expect.objectContaining({ content: {} }),
                chunk: [],
                nextBatch: undefined,
                prevBatch: undefined,
            });

            expect(client.relations).toBeCalledWith('!this-room-id', '$event', null, null, {});
        });

        it('reads related events if the original event is missing', async () => {
            client.relations.mockResolvedValue({
                // the relations function can return an undefined event, even
                // though the typings don't permit an undefined value.
                originalEvent: undefined as any,
                events: [],
            });

            await expect(driver.readEventRelations('$event', '!room-id')).resolves.toEqual({
                originalEvent: undefined,
                chunk: [],
                nextBatch: undefined,
                prevBatch: undefined,
            });

            expect(client.relations).toBeCalledWith('!room-id', '$event', null, null, {});
        });

        it('reads related events from a selected room', async () => {
            client.relations.mockResolvedValue({
                originalEvent: new MatrixEvent(),
                events: [new MatrixEvent(), new MatrixEvent()],
                nextBatch: 'next-batch-token',
            });

            await expect(driver.readEventRelations('$event', '!room-id')).resolves.toEqual({
                originalEvent: expect.objectContaining({ content: {} }),
                chunk: [
                    expect.objectContaining({ content: {} }),
                    expect.objectContaining({ content: {} }),
                ],
                nextBatch: 'next-batch-token',
                prevBatch: undefined,
            });

            expect(client.relations).toBeCalledWith('!room-id', '$event', null, null, {});
        });

        it('reads related events with custom parameters', async () => {
            client.relations.mockResolvedValue({
                originalEvent: new MatrixEvent(),
                events: [],
            });

            await expect(driver.readEventRelations(
                '$event',
                '!room-id',
                'm.reference',
                'm.room.message',
                'from-token',
                'to-token',
                25,
                'f',
            )).resolves.toEqual({
                originalEvent: expect.objectContaining({ content: {} }),
                chunk: [],
                nextBatch: undefined,
                prevBatch: undefined,
            });

            expect(client.relations).toBeCalledWith(
                '!room-id',
                '$event',
                'm.reference',
                'm.room.message',
                {
                    limit: 25,
                    from: 'from-token',
                    to: 'to-token',
                    direction: Direction.Forward,
                },
            );
        });
    });
});
