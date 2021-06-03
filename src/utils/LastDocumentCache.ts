import { TextDocument } from "vscode";

export class LastDocmentCache {
    private static cache:TextDocument | undefined;

    public static set(document: TextDocument) {
       this.cache = document
    }

    public static get(): TextDocument | undefined {
        return this.cache;
    }
}