import { assert } from "jsr:@std/assert@0.217/assert";
import Flatter from "../Flatter.ts"
import * as uuid from "jsr:@std/uuid";

class Address extends Flatter {
    street   = "";    
    city     = "";
    postcode = "";

    constructor( template ) {
        super(template);
        if (template) {
            Object.assign(this, template)
        }
    }

    static {
        this.init();
    }
}

class User extends Flatter {
    username = "";
    created  = new Date();
    shippingAddress = new Address();

    static {
        this.init();
    }

    constructor( template ) {
        super();
        if (template) {
            Object.assign(this, template)
        }
    }
}

const bill = new User({ 
    username: 'bill', 
    shippingAddress: new Address({ street: '17 West Street', city: 'Wareham'})
});
const aUUID = bill.uuid;
bill.save();

const record = Flatter.database.prepare(`SELECT * FROM users WHERE username = 'bill'`).get();
Deno.test({
    name: "record wrote correctly",
    fn() {
        assert(record.username == 'bill');
        assert(record.shippingAddress);
        assert(uuid.validate(record.uuid));
        assert(uuid.validate(record.shippingAddress));
    },
});

Deno.test({
    name: "test loading of record as ORM loadWithUUID",
    fn() {
        const billout = User.loadWithUUID( record.uuid );
        assert(billout.username == bill.username);
        assert(billout.uuid == bill.uuid);
        assert(billout.shippingAddress instanceof Address);
        assert(billout.shippingAddress.street = bill.shippingAddress.street);
    }
})


//console.log(billun)
Deno.test({
    name: "test loading of record as ORM query load",
    fn() {
        const billun = (User.load({ uuid: record.uuid }))[0];
        assert(billun.username == bill.username);
        assert(billun.uuid == bill.uuid);
        assert(billun.shippingAddress instanceof Address);
        assert(billun.shippingAddress.street = bill.shippingAddress.street);
    }
})

Deno.test({
    name: "re-save record with no problem",
    fn() {
        const thebill = User.loadWithUUID( aUUID );
        assert(thebill);
        thebill.username = "bob";
        thebill.save();
        const record2 = Flatter.database.prepare(`SELECT * FROM users WHERE uuid = ?`).get(aUUID);
        assert(record2.username == 'bob');
        assert(record2.shippingAddress);
        assert(uuid.validate(record.uuid));
        assert(uuid.validate(record.shippingAddress));
        assert(record2.uuid == record.uuid);
    },
});

