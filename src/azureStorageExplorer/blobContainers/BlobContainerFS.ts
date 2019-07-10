/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azureStorage from "azure-storage";
import * as path from 'path';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from "vscode-azureextensionui";
import { findRoot } from "../findRoot";
import { IParsedUri, parseUri } from "../parseUri";
import { BlobContainerTreeItem } from './blobContainerNode';
import { BlobDirectoryTreeItem } from "./BlobDirectoryTreeItem";
import { BlobTreeItem } from './blobNode';

export type EntryTreeItem = BlobTreeItem | BlobDirectoryTreeItem | BlobContainerTreeItem;

export class BlobContainerFS implements vscode.FileSystemProvider {

    private _blobContainerString: string = 'Blob Containers';

    private _emitter: vscode.EventEmitter<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        throw new Error("Method not implemented.");
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        let entry: EntryTreeItem = await this.lookup(uri);

        if (entry instanceof BlobDirectoryTreeItem || entry instanceof BlobContainerTreeItem) {
            // creation and modification times as well as size of tree item are intentionally set to 0 for now
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        } else if (entry instanceof BlobTreeItem) {
            // creation and modification times as well as size of tree item are intentionally set to 0 for now
            return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        let entry: BlobDirectoryTreeItem | BlobContainerTreeItem = await this.lookupAsDirectory(uri);

        let parsedUri = parseUri(uri, this._blobContainerString);

        const blobSerivce = entry.root.createBlobService();
        const listBlobResult = await this.listAllChildBlob(blobSerivce, parsedUri.rootName, parsedUri.dirPath);
        const listDirectoryResult = await this.listAllChildDirectory(blobSerivce, parsedUri.rootName, parsedUri.dirPath);

        let directoryChildren: [string, vscode.FileType][] = [];
        for (let blobRes of listBlobResult.entries) {
            let blobName = path.basename(blobRes.name);
            directoryChildren.push([blobName, vscode.FileType.File]);
        }

        for (let dirRes of listDirectoryResult.entries) {
            let dirName = path.basename(dirRes.name);
            directoryChildren.push([dirName, vscode.FileType.Directory]);
        }
        return directoryChildren;
    }

    createDirectory(_uri: vscode.Uri): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        let treeItem: BlobTreeItem = await this.lookupAsBlob(uri);

        let parsedUri = parseUri(uri, this._blobContainerString);

        let blobSerivce: azureStorage.BlobService = treeItem.root.createBlobService();
        const result = await new Promise<string | undefined>((resolve, reject) => {
            blobSerivce.getBlobToText(parsedUri.rootName, parsedUri.filePath, (error?: Error, text?: string) => {
                if (!!error) {
                    reject(error);
                } else {
                    resolve(text);
                }
            });
        });

        // tslint:disable-next-line: strict-boolean-expressions
        return Buffer.from(result || '');
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        await callWithTelemetryAndErrorHandling('blob.writeFile', async (context) => {
            if (!options.create && !options.overwrite) {
                throw vscode.FileSystemError.NoPermissions(uri);
            }

            let parsedUri = parseUri(uri, this._blobContainerString);
            let root: BlobContainerTreeItem = await this.getRoot(context, uri);

            const blobSerivce = root.root.createBlobService();
            let blobResultChild = await new Promise<azureStorage.BlobService.BlobResult>((resolve, reject) => {
                blobSerivce.doesBlobExist(parsedUri.rootName, parsedUri.filePath, (error?: Error, result?: azureStorage.BlobService.BlobResult) => {
                    if (!!error) {
                        reject(error);
                    } else {
                        resolve(result);
                    }
                });
            });

            if (!blobResultChild.exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            } else if (blobResultChild.exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            } else {
                await new Promise<void>((resolve, reject) => {
                    blobSerivce.createBlockBlobFromText(parsedUri.rootName, parsedUri.filePath, content.toString(), (error?: Error) => {
                        if (!!error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                });
            }
        });
    }

    // tslint:disable-next-line: no-reserved-keywords
    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        return await callWithTelemetryAndErrorHandling('blob.delete', async (context) => {
            context.errorHandling.rethrow = true;
            if (!options.recursive) {
                throw new Error('Do not support non recursive deletion of folders or files.');
            }

            let entry: EntryTreeItem = await this.lookup(uri);
            let parsedUri = parseUri(uri, this._blobContainerString);

            const blobService = entry.root.createBlobService();
            if (entry instanceof BlobTreeItem) {
                await this.deleteBlob(parsedUri.rootName, parsedUri.filePath, blobService);
            } else if (entry instanceof BlobDirectoryTreeItem) {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
                    progress.report({ message: `Deleting directory ${parsedUri.filePath}` });
                    await this.deleteFolder(parsedUri, blobService);
                });
            } else if (entry instanceof BlobContainerTreeItem) {
                throw new Error('Cannot delete a Blob Container.');
            }
        });
    }

    private async deleteFolder(parsedUri: IParsedUri, blobService: azureStorage.BlobService): Promise<void> {
        let dirPaths: string[] = [];
        let dirPath: string | undefined = parsedUri.dirPath;
        while (dirPath) {
            let childBlob = await this.listAllChildBlob(blobService, parsedUri.rootName, dirPath);
            for (const blob of childBlob.entries) {
                await this.deleteBlob(parsedUri.rootName, blob.name, blobService);
            }

            let childDir = await this.listAllChildDirectory(blobService, parsedUri.rootName, dirPath);
            for (const dir of childDir.entries) {
                dirPaths.push(dir.name);
            }

            dirPath = dirPaths.pop();
        }
    }

    private async deleteBlob(containerName: string, prefix: string, blobService: azureStorage.BlobService): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            blobService.deleteBlob(containerName, prefix, (error?: Error) => {
                if (!!error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    private async lookupAsBlob(uri: vscode.Uri): Promise<BlobTreeItem> {
        const entry = await this.lookup(uri);
        if (entry instanceof BlobTreeItem) {
            return entry;
        }
        throw vscode.FileSystemError.FileIsADirectory(uri);
    }

    private async lookupAsDirectory(uri: vscode.Uri): Promise<BlobDirectoryTreeItem | BlobContainerTreeItem> {
        let entry = await this.lookup(uri);
        if (entry instanceof BlobDirectoryTreeItem || entry instanceof BlobContainerTreeItem) {
            return entry;
        }
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    private async lookup(uri: vscode.Uri): Promise<EntryTreeItem> {
        return <EntryTreeItem>await callWithTelemetryAndErrorHandling('blob.lookup', async (context) => {
            context.errorHandling.rethrow = true;
            context.errorHandling.suppressDisplay = true;

            let parsedUri = parseUri(uri, this._blobContainerString);

            let entry = await this.getRoot(context, uri);
            if (parsedUri.filePath === '') {
                return entry;
            }

            let blobSerivce = entry.root.createBlobService();

            const listBlobDirectoryResult = await this.listAllChildDirectory(blobSerivce, parsedUri.rootName, parsedUri.parentDirPath);
            const directoryResultChild = listBlobDirectoryResult.entries.find(element => element.name === parsedUri.dirPath);
            if (!!directoryResultChild) {
                return new BlobDirectoryTreeItem(entry.root, parsedUri.baseName, parsedUri.parentDirPath, entry.container);
            } else {
                const listBlobResult = await this.listAllChildBlob(blobSerivce, parsedUri.rootName, parsedUri.parentDirPath);
                const blobResultChild = listBlobResult.entries.find(element => element.name === parsedUri.filePath);
                if (!!blobResultChild) {
                    return new BlobTreeItem(entry, blobResultChild, entry.container);
                }
                throw vscode.FileSystemError.FileNotFound(uri);
            }
        });
    }

    private async getRoot(context: IActionContext, uri: vscode.Uri): Promise<BlobContainerTreeItem> {
        let root = await findRoot(context, uri, this._blobContainerString);
        if (root instanceof BlobContainerTreeItem) {
            return root;
        } else {
            throw new RangeError('The root found must be a BlobContainerTreeItem.');
        }
    }

    private async listAllChildDirectory(blobSerivce: azureStorage.BlobService, blobContainerName: string, prefix: string): Promise<azureStorage.BlobService.ListBlobDirectoriesResult> {
        return await new Promise<azureStorage.BlobService.ListBlobDirectoriesResult>((resolve, reject) => {
            // Intentionally passing undefined for token - only supports listing first batch of files for now
            // tslint:disable-next-line: no-non-null-assertion
            blobSerivce.listBlobDirectoriesSegmentedWithPrefix(blobContainerName, prefix, <azureStorage.common.ContinuationToken>undefined!, (error?: Error, result?: azureStorage.BlobService.ListBlobDirectoriesResult) => {
                if (!!error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });
    }

    private async listAllChildBlob(blobSerivce: azureStorage.BlobService, blobContainerName: string, prefix: string): Promise<azureStorage.BlobService.ListBlobsResult> {
        return await new Promise<azureStorage.BlobService.ListBlobsResult>((resolve, reject) => {
            // Intentionally passing undefined for token - only supports listing first batch of files for now
            // tslint:disable-next-line: no-non-null-assertion
            let options = { delimiter: '/' };
            // tslint:disable-next-line: no-non-null-assertion
            blobSerivce.listBlobsSegmentedWithPrefix(blobContainerName, prefix, <azureStorage.common.ContinuationToken>undefined!, options, (error?: Error, result?: azureStorage.BlobService.ListBlobsResult) => {
                if (!!error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });
    }
}