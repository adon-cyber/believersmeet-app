// js/supabase-config.js (Replaced to bridge to Firebase Modular SDK)
import './firebase-init.js';

class FirebaseQueryBuilder {
    constructor(collectionName) {
        this.collectionName = collectionName;
        this.filters = [];
        this.orders = [];
        this.limitVal = null;
        this.isSingle = false;
        this.isMaybeSingle = false;
    }

    select(fields, options = {}) {
        if (options.count === 'exact') {
            this.countExact = true;
        }
        return this;
    }

    eq(field, value) {
        this.filters.push({ field, op: '==', value });
        return this;
    }

    neq(field, value) {
        this.filters.push({ field, op: '!=', value });
        return this;
    }

    gt(field, value) {
        this.filters.push({ field, op: '>', value });
        return this;
    }

    gte(field, value) {
        this.filters.push({ field, op: '>=', value });
        return this;
    }

    lt(field, value) {
        this.filters.push({ field, op: '<', value });
        return this;
    }

    lte(field, value) {
        this.filters.push({ field, op: '<=', value });
        return this;
    }

    order(field, options = {}) {
        this.orders.push({ field, direction: options.ascending === false ? 'desc' : 'asc' });
        return this;
    }

    limit(val) {
        this.limitVal = val;
        return this;
    }

    single() {
        this.isSingle = true;
        return this;
    }

    maybeSingle() {
        this.isMaybeSingle = true;
        return this;
    }

    async then(resolve, reject) {
        try {
            const db = window.db;
            const { collection, getDocs, query, where, orderBy, limit: fbLimit } = window.firebaseDb;
            
            let qRef = collection(db, this.collectionName);
            let qConstraints = [];

            for (let f of this.filters) {
                qConstraints.push(where(f.field, f.op, f.value));
            }
            for (let o of this.orders) {
                qConstraints.push(orderBy(o.field, o.direction));
            }
            if (this.limitVal) {
                qConstraints.push(fbLimit(this.limitVal));
            }

            const q = query(qRef, ...qConstraints);
            const snapshot = await getDocs(q);
            let data = [];
            snapshot.forEach(docSnap => {
                data.push({ id: docSnap.id, ...docSnap.data() });
            });

            if (this.countExact) {
                return resolve({ count: data.length, data, error: null });
            }

            if (this.isSingle) {
                if (data.length === 0) {
                    return resolve({ data: null, error: { message: 'Row not found' } });
                }
                return resolve({ data: data[0], error: null });
            }

            if (this.isMaybeSingle) {
                return resolve({ data: data.length > 0 ? data[0] : null, error: null });
            }

            return resolve({ data, error: null });
        } catch (err) {
            console.error("FirebaseQueryBuilder error:", err);
            return resolve({ data: null, error: err });
        }
    }
}

class FirebaseTableClient {
    constructor(tableName) {
        this.tableName = tableName;
    }

    select(fields, options) {
        const qb = new FirebaseQueryBuilder(this.tableName);
        return qb.select(fields, options);
    }

    async insert(records) {
        try {
            const db = window.db;
            const { collection, addDoc, doc, setDoc } = window.firebaseDb;
            const colRef = collection(db, this.tableName);
            
            const recordsArray = Array.isArray(records) ? records : [records];
            let insertedData = [];

            for (let record of recordsArray) {
                let dataToSave = { ...record, created_at: record.created_at || new Date().toISOString() };
                if (record.id) {
                    const docRef = doc(db, this.tableName, String(record.id));
                    await setDoc(docRef, dataToSave, { merge: true });
                    insertedData.push({ id: record.id, ...dataToSave });
                } else {
                    const docRef = await addDoc(colRef, dataToSave);
                    insertedData.push({ id: docRef.id, ...dataToSave });
                }
            }
            return { data: Array.isArray(records) ? insertedData : insertedData[0], error: null };
        } catch (err) {
            console.error("Firebase insert error:", err);
            return { data: null, error: err };
        }
    }

    async update(values) {
        this.updateValues = values;
        return this;
    }

    eq(field, value) {
        // Handle update query chaining e.g. .update({...}).eq('id', val)
        return (async () => {
            try {
                const db = window.db;
                const { collection, getDocs, query, where, doc, updateDoc } = window.firebaseDb;
                const qRef = collection(db, this.tableName);
                const q = query(qRef, where(field, '==', value));
                const snapshot = await getDocs(q);
                
                let updatedCount = 0;
                for (let docSnap of snapshot.docs) {
                    const docRef = doc(db, this.tableName, docSnap.id);
                    await updateDoc(docRef, { ...this.updateValues, updated_at: new Date().toISOString() });
                    updatedCount++;
                }
                return { data: null, error: null, count: updatedCount };
            } catch (err) {
                console.error("Firebase update error:", err);
                return { data: null, error: err };
            }
        })();
    }

    async delete() {
        this.isDelete = true;
        return this;
    }

    eq(field, value) {
        if (this.isDelete) {
            return (async () => {
                try {
                    const db = window.db;
                    const { collection, getDocs, query, where, doc, deleteDoc } = window.firebaseDb;
                    const qRef = collection(db, this.tableName);
                    const q = query(qRef, where(field, '==', value));
                    const snapshot = await getDocs(q);
                    
                    for (let docSnap of snapshot.docs) {
                        const docRef = doc(db, this.tableName, docSnap.id);
                        await deleteDoc(docRef);
                    }
                    return { data: null, error: null };
                } catch (err) {
                    console.error("Firebase delete error:", err);
                    return { data: null, error: err };
                }
            })();
        }
        
        const qb = new FirebaseQueryBuilder(this.tableName);
        return qb.eq(field, value);
    }
}

class FirebaseStorageBucketClient {
    constructor(bucketName) {
        this.bucketName = bucketName;
    }

    async upload(path, file, options = {}) {
        try {
            const storage = window.storage;
            const { ref, uploadBytes } = window.firebaseStorage;
            const storageRef = ref(storage, `${this.bucketName}/${path}`);
            await uploadBytes(storageRef, file);
            return { data: { path }, error: null };
        } catch (err) {
            console.error("Firebase storage upload error:", err);
            return { data: null, error: err };
        }
    }

    getPublicUrl(path) {
        // Return a helper object matching Supabase's { data: { publicUrl } } or URL string
        const cleanPath = `${this.bucketName}/${path}`;
        // Construct Firebase Storage download URL or storage path ref
        // For compatibility with UI expecting publicUrl, we return a simulated or direct download format
        const publicUrl = `https://firebasestorage.googleapis.com/v0/b/believersmeet-app.firebasestorage.app/o/${encodeURIComponent(cleanPath)}?alt=media`;
        return { data: { publicUrl }, publicUrl };
    }
}

class FirebaseStorageClient {
    from(bucketName) {
        return new FirebaseStorageBucketClient(bucketName);
    }
}

class FirebaseAuthClient {
    async getUser() {
        try {
            const auth = window.auth;
            return new Promise((resolve) => {
                const unsubscribe = window.firebaseAuth.onAuthStateChanged(auth, (user) => {
                    unsubscribe();
                    if (user) {
                        resolve({ 
                            data: { 
                                user: { 
                                    id: user.uid, 
                                    email: user.email,
                                    user_metadata: { full_name: user.displayName }
                                } 
                            }, 
                            error: null 
                        });
                    } else {
                        resolve({ data: { user: null }, error: null });
                    }
                });
            });
        } catch (err) {
            return { data: { user: null }, error: err };
        }
    }

    async getSession() {
        const res = await this.getUser();
        return { data: { session: res.data.user ? { user: res.data.user } : null }, error: res.error };
    }

    async signInWithPassword({ email, password }) {
        try {
            const auth = window.auth;
            const { signInWithEmailAndPassword } = window.firebaseAuth;
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            return { 
                data: { 
                    user: { id: user.uid, email: user.email },
                    session: { user: { id: user.uid, email: user.email } }
                }, 
                error: null 
            };
        } catch (err) {
            return { data: { user: null, session: null }, error: err };
        }
    }

    async signUp({ email, password, options = {} }) {
        try {
            const auth = window.auth;
            const { createUserWithEmailAndPassword } = window.firebaseAuth;
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            return { 
                data: { 
                    user: { id: user.uid, email: user.email },
                    session: { user: { id: user.uid, email: user.email } }
                }, 
                error: null 
            };
        } catch (err) {
            return { data: { user: null, session: null }, error: err };
        }
    }

    async signOut() {
        try {
            const auth = window.auth;
            const { signOut } = window.firebaseAuth;
            await signOut(auth);
            return { error: null };
        } catch (err) {
            return { error: err };
        }
    }

    onAuthStateChanged(callback) {
        const auth = window.auth;
        const { onAuthStateChanged } = window.firebaseAuth;
        return onAuthStateChanged(auth, (user) => {
            const session = user ? { user: { id: user.uid, email: user.email } } : null;
            callback(user ? 'SIGNED_IN' : 'SIGNED_OUT', session);
        });
    }

    async resetPasswordForEmail(email, options = {}) {
        try {
            const auth = window.auth;
            const { sendPasswordResetEmail } = window.firebaseAuth;
            await sendPasswordResetEmail(auth, email);
            return { error: null };
        } catch (err) {
            return { error: err };
        }
    }

    async updateUser(attributes) {
        try {
            const auth = window.auth;
            const { updatePassword } = window.firebaseAuth;
            if (attributes.password && auth.currentUser) {
                await updatePassword(auth.currentUser, attributes.password);
            }
            return { error: null };
        } catch (err) {
            return { error: err };
        }
    }
}

class FirebaseRealtimeChannel {
    constructor(channelName) {
        this.channelName = channelName;
        this.unsubscribers = [];
    }

    on(event, filter, callback) {
        try {
            const db = window.db;
            const { collection, onSnapshot, query, orderBy } = window.firebaseDb;
            // Parse table name from channel or filter
            const tableName = filter.table || this.channelName.replace('public:', '').split('-')[0];
            const colRef = collection(db, tableName);
            const unsub = onSnapshot(colRef, (snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added' || change.type === 'modified' || change.type === 'removed') {
                        callback({
                            eventType: change.type.toUpperCase(),
                            new: { id: change.doc.id, ...change.doc.data() },
                            old: change.oldDoc ? { id: change.oldDoc.id, ...change.oldDoc.data() } : {}
                        });
                    }
                });
            });
            this.unsubscribers.push(unsub);
        } catch (err) {
            console.error("Realtime subscription error:", err);
        }
        return this;
    }

    subscribe() {
        return this;
    }
}

class FirebaseClientProxy {
    constructor() {
        this.auth = new FirebaseAuthClient();
        this.storage = new FirebaseStorageClient();
    }

    from(tableName) {
        return new FirebaseTableClient(tableName);
    }

    channel(name, config) {
        return new FirebaseRealtimeChannel(name);
    }

    removeChannel(channel) {
        if (channel && channel.unsubscribers) {
            channel.unsubscribers.forEach(unsub => unsub());
        }
    }
}

window.supabaseClient = new FirebaseClientProxy();
window.sbClient = window.supabaseClient;
console.log("Supabase Client shim successfully bridged to Firebase Modular SDK (v10+).");
