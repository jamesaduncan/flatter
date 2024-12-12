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
    //
let billout = User.loadWithUUID( record.uuid );
Deno.test({
    name: "test loading of record as ORM load",
    fn() {
        assert(billout.username == bill.username);
        assert(billout.uuid == bill.uuid);
        assert(billout.shippingAddress instanceof Address);
        assert(billout.shippingAddress.street = bill.shippingAddress.street);
    }
})
//console.log( User.loadWithUUID( bill.uuid ) );

let billun = (User.load({ username: 'bill' }))[0];
//console.log(billun);
