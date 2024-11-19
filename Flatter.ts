import { Database } from "jsr:@db/sqlite@0.11";
import julian from "npm:julian@0.2.0";
import { plural } from "https://deno.land/x/deno_plural@2.0.0/mod.ts";

let DBConnection = new Database("flatter.sqlite");
DBConnection.run('PRAGMA journal_mode = WAL;')        
DBConnection.run('PRAGMA FOREIGN_KEY = ON;')        

interface IDBTypeConversion {
    toPlaceholder? : string | Function;
    toDBValue? : string | Function;
    toJSValue? : string | Function;
}

interface IDBTypeConversions {
    [key: string] : IDBTypeConversion;
}

interface IRowInfo {
    cid : string;
    name : string;
    type : string;
    notnull : number;
    dflt_value: unknown;
    pk : number;
}

interface ITableInfo {
    [key : string] : IRowInfo;
}

interface Storable {
    uuid   : string;

    save() : boolean;
}

/* This defines the static interface for Flatter */
interface Loadable {
    new() : Storable;

    SQLDefinition : string;
    tableInfo : ITableInfo;
    DBTypeConversions : IDBTypeConversions;

    get tablename() : string;
    get dbColumns() : string[];
    get dbPlaceholders() : string[];

    load( uuid : string, cache? : object) : Storable;
    init() : void;

    useDatabase( aDatabase : Database ) : void;
}

function staticImplements<T>() {
    return <U extends T>(constructor: U) => { constructor };
}

@staticImplements<Loadable>()
class Flatter {
    uuid: string;

    static SQLDefinition = "";
    static DBTypeConversions : IDBTypeConversions = {};
    static tableInfo : ITableInfo = ({} as ITableInfo);

    private static DBTypes = {};

    get flatter () {
        return this;
    }

    static get tablename() : string {
        return plural(this.name);
    }

    constructor( aTemplate? : object ) {
        this.uuid = crypto.randomUUID();
        Object.assign(this, aTemplate);
    }

    static init() {
        const tablename = this.tablename;

        const tableDetails = DBConnection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tablename}'`).get();
        if (!tableDetails) {
            /* we need to set up the table */
            DBConnection.run( this.SQLDefinition );
        }

        const info = DBConnection.prepare(`PRAGMA table_info(${tablename})`).all();
        info.forEach( (infoRow) => {
            const castInfo : IRowInfo = (infoRow as IRowInfo);
            let DBType = castInfo.type;
            if (!this.DBTypeConversions[ DBType ]) throw new Error(`type ${DBType} used in database is not defined in software`);
            this.tableInfo[ castInfo.name ] = castInfo;
        })
    }

    static useDatabase( aDatabase : Database ) : void {
        DBConnection = aDatabase;
    }

    static get dbColumns() : string[] {
        return Object.keys(this.tableInfo);
    }

    static get dbPlaceholders() : string[] {
        const theClass = (this as Loadable);
        const tableInfoValues = Object.values(this.tableInfo);
        return tableInfoValues.map( (e: IRowInfo) => {
            const placeholder = theClass.DBTypeConversions[ e.type ].toPlaceholder;
            if (!placeholder) return '?';
            if ( typeof(placeholder) == 'string' ) {
                return placeholder;
            } else {
                return placeholder();
            }
        })
    }

    get dbValues() : string[] {
        const theClass = (this.constructor as Loadable);
        const tableInfo = theClass.tableInfo;
        return Object.values( tableInfo ).map( ( row : IRowInfo ) : string => {
            const value = Reflect.get(this, row.name);
            const toDBValue = theClass.DBTypeConversions[row.type].toDBValue;
            console.log(`toDBValue for ${row.name} is`, toDBValue);
            console.log(`value for ${row.name} is `,value)
            if (!toDBValue) {
                return (value as string);
            }
            if (toDBValue) {
                if ( typeof(toDBValue) == 'string' ) return toDBValue;
                return toDBValue( value );
            }
            return '';
        })
    }

    save(): boolean {        
        const tablename       = (this.constructor as Loadable).tablename;
        const columns         = (this.constructor as Loadable).dbColumns;
        const dbPlaceholders  = (this.constructor as Loadable).dbPlaceholders;
        const sql = `INSERT OR REPLACE INTO ${tablename} (${columns.join(", ")}) VALUES(${dbPlaceholders.join(", ")})`
        console.log(sql, this.dbValues);
        return true;
    }

    public static load( uuid: string, cache? : object) : Storable {
        return new this();
    }

    static declareDBType( aType : string, aDefinition : IDBTypeConversion) : void {
        const theClass = (this as Loadable);
        theClass.DBTypeConversions[ aType ] = aDefinition;
    }
}

Flatter.declareDBType('UUID', {});
Flatter.declareDBType('TEXT', {});
Flatter.declareDBType('DATETIME', {
    toDBValue    : (e : object ) : string => { return julian( e ) },
});
Flatter.declareDBType('OBJECT', {
    toPlaceholder: 'json(?)',
    toDBValue    : (e: object) : string => { return JSON.stringify(e) }
})

export default Flatter;